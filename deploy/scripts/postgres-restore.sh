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

echo "Restored and validated checksum into database: $TARGET_DB"
