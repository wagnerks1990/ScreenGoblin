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
require_environment POSTGRES_DB
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

  if printf '%s' "$source_uri" | LC_ALL=C grep -q '[[:space:]]'; then
    printf '%s must not contain whitespace.\n' "$source_label" >&2
    exit 64
  fi
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
# silently changing its meaning.
to_libpq_uri "$MIGRATION_DATABASE_URL" MIGRATION_DATABASE_URL
MIGRATION_LIBPQ_DATABASE_URI=$LIBPQ_DATABASE_URI
to_libpq_uri "$DATABASE_URL" DATABASE_URL
RUNTIME_LIBPQ_DATABASE_URI=$LIBPQ_DATABASE_URI

percent_decode() {
  encoded_value=$1
  printf '%s' "$encoded_value" | LC_ALL=C awk '
    function hex(character) {
      character = toupper(character)
      return index("0123456789ABCDEF", character) - 1
    }
    {
      decoded = ""
      for (index_in_value = 1; index_in_value <= length($0); index_in_value++) {
        character = substr($0, index_in_value, 1)
        if (character == "%") {
          if (index_in_value + 2 > length($0)) exit 2
          high = hex(substr($0, index_in_value + 1, 1))
          low = hex(substr($0, index_in_value + 2, 1))
          if (high < 0 || low < 0) exit 2
          code = high * 16 + low
          if (code <= 32 || code == 127) exit 2
          decoded = decoded sprintf("%c", code)
          index_in_value += 2
        } else {
          decoded = decoded character
        }
      }
      printf "%s", decoded
    }
  '
}

parse_database_uri() {
  connection_uri=$1
  expected_user=$2
  source_label=$3
  without_scheme=${connection_uri#*://}
  authority=${without_scheme%%/*}
  database_name=${without_scheme#*/}

  case "$without_scheme" in */*) ;; *) connection_invalid=true ;; esac
  case "$database_name" in '' | */*) connection_invalid=true ;; esac
  case "$authority" in *@*) ;; *) connection_invalid=true ;; esac
  userinfo=${authority%%@*}
  host_and_port=${authority#*@}
  case "$host_and_port" in *@*) connection_invalid=true ;; esac
  case "$userinfo" in *:*) ;; *) connection_invalid=true ;; esac
  uri_user=${userinfo%%:*}
  encoded_password=${userinfo#*:}
  case "$host_and_port" in *:*) ;; *) connection_invalid=true ;; esac
  database_host=${host_and_port%%:*}
  database_port=${host_and_port#*:}

  case "$database_host" in '' | *[!A-Za-z0-9.-]*) connection_invalid=true ;; esac
  case "$database_port" in '' | *[!0-9]*) connection_invalid=true ;; esac
  if [ "$uri_user" != "$expected_user" ] || [ "$database_name" != "$POSTGRES_DB" ]; then
    connection_invalid=true
  fi
  if [ "${connection_invalid-}" = true ]; then
    printf '%s does not match the supported deployment database URI shape.\n' "$source_label" >&2
    exit 64
  fi
  if ! database_password=$(percent_decode "$encoded_password"); then
    printf '%s contains invalid password encoding.\n' "$source_label" >&2
    exit 64
  fi
  if [ -z "$database_password" ]; then
    printf '%s must contain a password.\n' "$source_label" >&2
    exit 64
  fi

  PARSED_DATABASE_HOST=$database_host
  PARSED_DATABASE_PORT=$database_port
  PARSED_DATABASE_NAME=$database_name
  PARSED_DATABASE_USER=$uri_user
  PARSED_DATABASE_PASSWORD=$database_password
  unset connection_invalid
}

parse_database_uri "$MIGRATION_LIBPQ_DATABASE_URI" "$POSTGRES_USER" MIGRATION_DATABASE_URL
MIGRATION_DATABASE_HOST=$PARSED_DATABASE_HOST
MIGRATION_DATABASE_PORT=$PARSED_DATABASE_PORT
MIGRATION_DATABASE_NAME=$PARSED_DATABASE_NAME
MIGRATION_DATABASE_USER=$PARSED_DATABASE_USER
MIGRATION_DATABASE_PASSWORD=$PARSED_DATABASE_PASSWORD
parse_database_uri "$RUNTIME_LIBPQ_DATABASE_URI" "$POSTGRES_RUNTIME_USER" DATABASE_URL
RUNTIME_DATABASE_HOST=$PARSED_DATABASE_HOST
RUNTIME_DATABASE_PORT=$PARSED_DATABASE_PORT
RUNTIME_DATABASE_NAME=$PARSED_DATABASE_NAME
RUNTIME_DATABASE_USER=$PARSED_DATABASE_USER
RUNTIME_DATABASE_PASSWORD=$PARSED_DATABASE_PASSWORD

if [ "$MIGRATION_DATABASE_HOST" != "$RUNTIME_DATABASE_HOST" ] ||
  [ "$MIGRATION_DATABASE_PORT" != "$RUNTIME_DATABASE_PORT" ] ||
  [ "$RUNTIME_DATABASE_PASSWORD" != "$POSTGRES_RUNTIME_PASSWORD" ]; then
  printf 'Database URLs do not match the declared deployment database contract.\n' >&2
  exit 64
fi

temporary_directory=${TMPDIR:-/tmp}
umask 077
service_file=$(mktemp "$temporary_directory/screengoblin-pg-service.XXXXXX")
cleanup() {
  rm -f -- "$service_file"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
chmod 600 "$service_file"
{
  printf '[migration]\n'
  printf 'host=%s\n' "$MIGRATION_DATABASE_HOST"
  printf 'port=%s\n' "$MIGRATION_DATABASE_PORT"
  printf 'dbname=%s\n' "$MIGRATION_DATABASE_NAME"
  printf 'user=%s\n' "$MIGRATION_DATABASE_USER"
  printf 'password=%s\n' "$MIGRATION_DATABASE_PASSWORD"
  printf '[runtime]\n'
  printf 'host=%s\n' "$RUNTIME_DATABASE_HOST"
  printf 'port=%s\n' "$RUNTIME_DATABASE_PORT"
  printf 'dbname=%s\n' "$RUNTIME_DATABASE_NAME"
  printf 'user=%s\n' "$RUNTIME_DATABASE_USER"
  printf 'password=%s\n' "$RUNTIME_DATABASE_PASSWORD"
} > "$service_file"

# The private service file transports validated connection components without
# placing secrets in argv or output and works in UID 70's writable /tmp tmpfs.
unset PGDATABASE
PGSERVICEFILE=$service_file
export PGSERVICEFILE
PGSERVICE=migration
export PGSERVICE
psql \
  --no-psqlrc \
  --set=migrator_role="$POSTGRES_USER" \
  --set=runtime_role="$POSTGRES_RUNTIME_USER" \
  --file="$script_directory/provision-runtime-role.sql"

# Prove that the exact URL supplied to the long-running API authenticates as
# the constrained role and that the effective denial boundary is intact.
PGSERVICE=runtime
export PGSERVICE
psql \
  --no-psqlrc \
  --set=runtime_role="$POSTGRES_RUNTIME_USER" \
  --file="$script_directory/verify-runtime-role.sql"
