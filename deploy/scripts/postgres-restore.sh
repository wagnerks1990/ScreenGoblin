#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 path/to/backup.dump" >&2
  exit 2
fi

readonly BACKUP="$1"
readonly CHECKSUM="$BACKUP.sha256"
readonly TARGET_DB="${POSTGRES_RESTORE_DATABASE:-screengoblin_restore_validation}"
readonly POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
readonly ENV_FILE="${SCREENGOBLIN_ENV_FILE:-deploy/.env}"

[[ -f "$BACKUP" && -f "$CHECKSUM" ]] || {
  echo "Backup and adjacent .sha256 checksum are required" >&2
  exit 2
}
[[ -f "$ENV_FILE" ]] || { echo "Environment file not found: $ENV_FILE" >&2; exit 2; }
[[ "$TARGET_DB" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || {
  echo "POSTGRES_RESTORE_DATABASE is not a safe PostgreSQL identifier" >&2
  exit 2
}

case "$TARGET_DB" in
  postgres|template0|template1|screengoblin)
    if [[ "${ALLOW_DANGEROUS_RESTORE:-}" != "I_UNDERSTAND_THIS_CAN_DESTROY_DATA" ]]; then
      echo "Refusing restore into protected database '$TARGET_DB'. Use an isolated validation database." >&2
      exit 2
    fi
    ;;
esac

command -v docker >/dev/null
command -v sha256sum >/dev/null
(
  cd "$(dirname "$BACKUP")"
  sha256sum --check --strict "$(basename "$CHECKSUM")"
)

active_db="$(docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" \
  sh -ceu 'printf %s "$POSTGRES_DB"')"
if [[ "$TARGET_DB" == "$active_db" && "${ALLOW_DANGEROUS_RESTORE:-}" != "I_UNDERSTAND_THIS_CAN_DESTROY_DATA" ]]; then
  echo "Refusing restore into the active database '$TARGET_DB'. Use an isolated validation database." >&2
  exit 2
fi

db_exists="$(docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" sh -ceu '
  psql --username "$POSTGRES_USER" --dbname postgres --tuples-only \
    --command "SELECT 1 FROM pg_database WHERE datname = '\''$1'\''"
' sh "$TARGET_DB")"
if [[ "$db_exists" == *1* ]]; then
  if [[ "${ALLOW_EXISTING_RESTORE_DATABASE:-}" != "I_UNDERSTAND_THIS_OVERWRITES_A_DATABASE" ]]; then
    echo "Refusing to overwrite existing database '$TARGET_DB'" >&2
    exit 2
  fi
  docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" sh -ceu '
    dropdb --force --username "$POSTGRES_USER" "$1"
  ' sh "$TARGET_DB"
fi

docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" sh -ceu '
  createdb --username "$POSTGRES_USER" "$1"
' sh "$TARGET_DB"
if ! docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" sh -ceu '
  pg_restore --exit-on-error --no-owner --no-acl \
    --username "$POSTGRES_USER" --dbname "$1"
' sh "$TARGET_DB" < "$BACKUP"; then
  echo "Restore failed; removing incomplete validation database" >&2
  docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" sh -ceu '
    dropdb --force --username "$POSTGRES_USER" "$1"
  ' sh "$TARGET_DB" || true
  exit 1
fi

remove_incomplete_restore() {
  echo "Restore privilege reconciliation or runtime validation failed; removing incomplete validation database" >&2
  docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" sh -ceu '
    dropdb --force --username "$POSTGRES_USER" "$1"
  ' sh "$TARGET_DB" || true
}

# A --no-owner/--no-acl restore intentionally discards the source grants. Apply
# the same idempotent privilege reconciliation used after migrations to the
# restored target, then prove the runtime identity can read application data but
# cannot read Prisma's migration ledger or create schema objects. The migration
# and runtime URLs are rewritten only inside the short-lived container
# so their passwords never appear in host process arguments or output.
if ! docker compose --env-file "$ENV_FILE" run --rm --no-deps \
  --env POSTGRES_RESTORE_TARGET_DB="$TARGET_DB" \
  --entrypoint /bin/sh api-db-privileges -ceu '
    migration_url_without_query=${MIGRATION_DATABASE_URL%%\?*}
    case "$MIGRATION_DATABASE_URL" in
      *\?*) migration_query="?${MIGRATION_DATABASE_URL#*\?}" ;;
      *) migration_query= ;;
    esac
    migration_url_prefix=${migration_url_without_query%/*}
    if [ "$migration_url_prefix" = "$migration_url_without_query" ]; then
      echo "MIGRATION_DATABASE_URL does not contain a database path" >&2
      exit 64
    fi
    export MIGRATION_DATABASE_URL="${migration_url_prefix}/${POSTGRES_RESTORE_TARGET_DB}${migration_query}"

    runtime_url_without_query=${DATABASE_URL%%\?*}
    case "$DATABASE_URL" in
      *\?*) runtime_query="?${DATABASE_URL#*\?}" ;;
      *) runtime_query= ;;
    esac
    runtime_url_prefix=${runtime_url_without_query%/*}
    if [ "$runtime_url_prefix" = "$runtime_url_without_query" ]; then
      echo "DATABASE_URL does not contain a database path" >&2
      exit 64
    fi
    export DATABASE_URL="${runtime_url_prefix}/${POSTGRES_RESTORE_TARGET_DB}${runtime_query}"

    /opt/screengoblin/postgres/provision-runtime-role.sh

    export PGPASSWORD="$POSTGRES_RUNTIME_PASSWORD"
    psql_runtime() {
      psql --host=postgres --username="$POSTGRES_RUNTIME_USER" \
        --dbname="$POSTGRES_RESTORE_TARGET_DB" --no-psqlrc --no-password \
        --set=ON_ERROR_STOP=1 "$@"
    }

    restored_database=$(psql_runtime --tuples-only --no-align \
      --command "SELECT current_database()")
    [ "$restored_database" = "$POSTGRES_RESTORE_TARGET_DB" ]
    runtime_app_privileges=$(psql_runtime --tuples-only --no-align --command '"'"'
      SELECT has_table_privilege(current_user, '"'"'"'"'public."Screen"'"'"'"'"', '"'"'"'"'SELECT'"'"'"'"')
        AND has_table_privilege(current_user, '"'"'"'"'public."Screen"'"'"'"'"', '"'"'"'"'INSERT'"'"'"'"')
        AND has_table_privilege(current_user, '"'"'"'"'public."Screen"'"'"'"'"', '"'"'"'"'UPDATE'"'"'"'"')
        AND has_table_privilege(current_user, '"'"'"'"'public."Screen"'"'"'"'"', '"'"'"'"'DELETE'"'"'"'"')
    '"'"')
    [ "$runtime_app_privileges" = t ]
    psql_runtime --command '"'"'SELECT 1 FROM public."User" LIMIT 1'"'"' >/dev/null
    psql_runtime --command '"'"'
      BEGIN;
      UPDATE public."Screen"
      SET "updatedAt" = "updatedAt"
      WHERE "id" = (SELECT "id" FROM public."Screen" LIMIT 1);
      ROLLBACK;
    '"'"' >/dev/null
    if psql_runtime --command '"'"'SELECT 1 FROM public."_prisma_migrations" LIMIT 1'"'"' >/dev/null 2>&1; then
      echo "Runtime role can read the migration ledger after restore" >&2
      exit 1
    fi
    if psql_runtime --command '"'"'TRUNCATE TABLE public."User"'"'"' >/dev/null 2>&1; then
      echo "Runtime role can truncate application tables after restore" >&2
      exit 1
    fi
    if psql_runtime --command '"'"'BEGIN; CREATE SCHEMA runtime_restore_probe; ROLLBACK'"'"' >/dev/null 2>&1; then
      echo "Runtime role can create schema objects after restore" >&2
      exit 1
    fi
  '; then
  remove_incomplete_restore
  exit 1
fi

echo "Restored checksum, reconciled privileges, and validated runtime access in database: $TARGET_DB"
