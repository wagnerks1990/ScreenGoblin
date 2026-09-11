#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly BACKUP_DIR="${POSTGRES_BACKUP_DIR:-backups/postgres}"
readonly BACKUP_NAME="${POSTGRES_BACKUP_NAME:-screengoblin-$(date -u +%Y%m%dT%H%M%SZ).dump}"
readonly POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
readonly ENV_FILE="${SCREENGOBLIN_ENV_FILE:-deploy/.env}"

[[ "$BACKUP_NAME" =~ ^[A-Za-z0-9._-]+\.dump$ ]] || {
  echo "POSTGRES_BACKUP_NAME must be a simple .dump filename" >&2
  exit 2
}
[[ -f "$ENV_FILE" ]] || { echo "Environment file not found: $ENV_FILE" >&2; exit 2; }
command -v docker >/dev/null
command -v sha256sum >/dev/null

mkdir -p -m 0700 "$BACKUP_DIR"
readonly DESTINATION="$BACKUP_DIR/$BACKUP_NAME"
readonly CHECKSUM="$DESTINATION.sha256"
if [[ -e "$DESTINATION" || -e "$CHECKSUM" ]]; then
  echo "Refusing to overwrite existing backup or checksum: $DESTINATION" >&2
  exit 2
fi

tmp="$(mktemp "$BACKUP_DIR/.postgres-backup.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

docker compose --env-file "$ENV_FILE" exec -T "$POSTGRES_SERVICE" sh -ceu '
  pg_dump --format=custom --no-owner --no-acl \
    --username "$POSTGRES_USER" "$POSTGRES_DB"
' > "$tmp"
[[ -s "$tmp" ]] || { echo "Backup is empty" >&2; exit 1; }
mv "$tmp" "$DESTINATION"
(
  cd "$BACKUP_DIR"
  sha256sum "$BACKUP_NAME" > "$BACKUP_NAME.sha256"
  sha256sum --check --strict "$BACKUP_NAME.sha256"
)
trap - EXIT
echo "$DESTINATION"
