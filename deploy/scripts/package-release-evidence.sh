#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly EVIDENCE_DIR="${1:-release-evidence}"
readonly ARCHIVE="${2:-release-evidence.tar.gz}"
readonly CHECKSUM="${ARCHIVE}.sha256"

command -v gzip >/dev/null
command -v realpath >/dev/null
command -v sha256sum >/dev/null
command -v tar >/dev/null

[[ -d "$EVIDENCE_DIR" ]] || {
  echo "Evidence directory does not exist: $EVIDENCE_DIR" >&2
  exit 2
}
[[ ! -e "$ARCHIVE" && ! -e "$CHECKSUM" ]] || {
  echo "Refusing to overwrite an existing archive or checksum: $ARCHIVE" >&2
  exit 2
}

readonly EVIDENCE_ABS="$(realpath "$EVIDENCE_DIR")"
readonly ARCHIVE_ABS="$(realpath -m "$ARCHIVE")"
case "$ARCHIVE_ABS" in
  "$EVIDENCE_ABS"/*)
    echo "Archive must be written outside the evidence directory" >&2
    exit 2
    ;;
esac

LC_ALL=C tar \
  --sort=name \
  --mtime='@0' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --mode='u+rwX,go-rwx' \
  --format=gnu \
  --directory="$EVIDENCE_DIR" \
  --create --file=- . \
  | gzip -n > "$ARCHIVE"

readonly ARCHIVE_DIR="$(dirname "$ARCHIVE_ABS")"
readonly ARCHIVE_NAME="$(basename "$ARCHIVE_ABS")"
(
  cd "$ARCHIVE_DIR"
  sha256sum "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
  sha256sum --check --strict "$ARCHIVE_NAME.sha256"
)

echo "Deterministic evidence archive written to $ARCHIVE"
