#!/bin/sh

set -eu

require_environment() {
  variable_name=$1
  eval "variable_value=\${$variable_name-}"
  if [ -z "$variable_value" ]; then
    printf 'Required environment variable %s is empty or unset.\n' "$variable_name" >&2
    exit 64
  fi
}

require_environment MIGRATION_DATABASE_URL
require_environment DATABASE_URL
require_environment POSTGRES_USER
require_environment POSTGRES_RUNTIME_USER
require_environment POSTGRES_RUNTIME_PASSWORD

if [ "$POSTGRES_USER" = "$POSTGRES_RUNTIME_USER" ]; then
  printf 'POSTGRES_RUNTIME_USER must differ from the migration owner POSTGRES_USER.\n' >&2
  exit 64
fi

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

to_libpq_uri() {
  source_uri=$1
  source_label=$2

  case "$source_uri" in
    postgresql://* | postgres://*) ;;
    *)
      printf '%s must be a PostgreSQL URI.\n' "$source_label" >&2
      exit 64
      ;;
  esac
  case "$source_uri" in
    *'#'*)
      printf '%s must not contain a URI fragment.\n' "$source_label" >&2
      exit 64
      ;;
    *'?schema=public')
      uri_without_schema=${source_uri%schema=public}
      uri_without_schema=${uri_without_schema%\?}
      case "$uri_without_schema" in
        *'?'*)
          printf '%s has an ambiguous or unsupported query string.\n' "$source_label" >&2
          exit 64
          ;;
      esac
      LIBPQ_DATABASE_URI=$uri_without_schema
      ;;
    *'?'*)
      printf '%s has an unsupported query string; only schema=public is accepted.\n' "$source_label" >&2
      exit 64
      ;;
    *) LIBPQ_DATABASE_URI=$source_uri ;;
  esac
}

# A Prisma URL's exact `schema=public` query is not a libpq connection option.
# Strip only that bounded form, rejecting every ambiguous query rather than
# silently changing its meaning. PGDATABASE keeps both URLs out of argv.
to_libpq_uri "$MIGRATION_DATABASE_URL" MIGRATION_DATABASE_URL
MIGRATION_LIBPQ_DATABASE_URI=$LIBPQ_DATABASE_URI
to_libpq_uri "$DATABASE_URL" DATABASE_URL
RUNTIME_LIBPQ_DATABASE_URI=$LIBPQ_DATABASE_URI

PGDATABASE=$MIGRATION_LIBPQ_DATABASE_URI
export PGDATABASE
psql \
  --no-psqlrc \
  --set=migrator_role="$POSTGRES_USER" \
  --set=runtime_role="$POSTGRES_RUNTIME_USER" \
  --file="$script_directory/provision-runtime-role.sql"

# Prove that the exact URL supplied to the long-running API authenticates as
# the constrained role and that the effective denial boundary is intact.
PGDATABASE=$RUNTIME_LIBPQ_DATABASE_URI
export PGDATABASE
exec psql \
  --no-psqlrc \
  --set=runtime_role="$POSTGRES_RUNTIME_USER" \
  --file="$script_directory/verify-runtime-role.sql"
