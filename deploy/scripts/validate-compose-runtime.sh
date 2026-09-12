#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly DOCKER_BIN="${DOCKER_BIN:-docker}"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly OPENSSL_BIN="${OPENSSL_BIN:-openssl}"
readonly WAIT_TIMEOUT_SECONDS="${COMPOSE_SMOKE_TIMEOUT_SECONDS:-240}"
readonly EVIDENCE_DIR="${COMPOSE_SMOKE_EVIDENCE_DIR:-$ROOT_DIR/compose-smoke-evidence}"

[[ "$WAIT_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] &&
  ((WAIT_TIMEOUT_SECONDS >= 30 && WAIT_TIMEOUT_SECONDS <= 900)) || {
  echo "COMPOSE_SMOKE_TIMEOUT_SECONDS must be between 30 and 900" >&2
  exit 2
}
[[ ! -e "$EVIDENCE_DIR" ]] || {
  echo "Refusing to overwrite existing Compose smoke evidence: $EVIDENCE_DIR" >&2
  exit 2
}

command -v "$DOCKER_BIN" >/dev/null
command -v "$CURL_BIN" >/dev/null
command -v "$OPENSSL_BIN" >/dev/null
command -v awk >/dev/null

mkdir -p "$EVIDENCE_DIR"
work_dir="$(mktemp -d)"
readonly work_dir
trap 'rm -rf "$work_dir"' EXIT
readonly env_file="$work_dir/runtime.env"
readonly caddy_file="$work_dir/Caddyfile"
readonly override_file="$work_dir/compose.override.yml"

project_name="${COMPOSE_SMOKE_PROJECT:-screengoblin-smoke-${GITHUB_RUN_ID:-$$}-${RANDOM}}"
project_name="$(printf '%s' "$project_name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]+$ ]] || {
  echo "COMPOSE_SMOKE_PROJECT must produce a valid Compose project name" >&2
  exit 2
}
readonly project_name

random_hex() {
  "$OPENSSL_BIN" rand -hex "$1" | tr -d '\r\n'
}

export SCREEN_GOBLIN_HOST="signage.example.test"
export PLAYER_HOST="player.example.test"
export ACME_EMAIL="ops@smoke.example.test"
export POSTGRES_DB="screengoblin"
export POSTGRES_USER="screengoblin"
export POSTGRES_PASSWORD="$(random_hex 32)"
export DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB?schema=public"
export JWT_SECRET="$(random_hex 48)"
export PAIRING_CODE_PEPPER="$(random_hex 48)"
export MEDIA_DELIVERY_SECRET="$(random_hex 48)"
export MANIFEST_SIGNING_PRIVATE_KEY
MANIFEST_SIGNING_PRIVATE_KEY="$($OPENSSL_BIN rand -base64 32 | tr '+/' '-_' | tr -d '=\r\n')"
export MINIO_ROOT_USER="screengoblin-smoke-root"
export MINIO_ROOT_PASSWORD="$(random_hex 32)"
export S3_BUCKET="screengoblin-smoke-media"
export S3_REGION="us-east-1"
export S3_ACCESS_KEY_ID="screengoblin-smoke-api"
export S3_SECRET_ACCESS_KEY="$(random_hex 32)"
export SEED_ADMIN_EMAIL="admin@smoke.example.test"
export SEED_ADMIN_PASSWORD="$(random_hex 32)"
export SEED_ADMIN_NAME="Compose Smoke Administrator"
export SEED_ORGANIZATION_NAME="Compose Smoke"
export SEED_ORGANIZATION_SLUG="compose-smoke"
export LOG_LEVEL="warn"
export EMERGENCY_FEATURE_ENABLED="false"

[[ "$MANIFEST_SIGNING_PRIVATE_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]] || {
  echo "Failed to generate a base64url manifest signing seed" >&2
  exit 1
}

cat >"$env_file" <<EOF
SCREEN_GOBLIN_HOST=$SCREEN_GOBLIN_HOST
PLAYER_HOST=$PLAYER_HOST
ACME_EMAIL=$ACME_EMAIL
POSTGRES_DB=$POSTGRES_DB
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DATABASE_URL=$DATABASE_URL
JWT_SECRET=$JWT_SECRET
PAIRING_CODE_PEPPER=$PAIRING_CODE_PEPPER
MEDIA_DELIVERY_SECRET=$MEDIA_DELIVERY_SECRET
DEVICE_AUTH_MODE=proof-v1
MANIFEST_SIGNING_PRIVATE_KEY=$MANIFEST_SIGNING_PRIVATE_KEY
MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
S3_BUCKET=$S3_BUCKET
S3_REGION=$S3_REGION
S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
SEED_ADMIN_EMAIL=$SEED_ADMIN_EMAIL
SEED_ADMIN_PASSWORD=$SEED_ADMIN_PASSWORD
SEED_ADMIN_NAME=$SEED_ADMIN_NAME
SEED_ORGANIZATION_NAME=$SEED_ORGANIZATION_NAME
SEED_ORGANIZATION_SLUG=$SEED_ORGANIZATION_SLUG
LOG_LEVEL=$LOG_LEVEL
EMERGENCY_FEATURE_ENABLED=$EMERGENCY_FEATURE_ENABLED
EOF

# Use Caddy's local CA only for this disposable smoke environment. The checked-in
# production Caddyfile retains normal ACME behavior.
awk 'NR == 1 { print; print "  local_certs"; next } { print }' \
  "$ROOT_DIR/deploy/caddy/Caddyfile" >"$caddy_file"
export SMOKE_CADDYFILE="$caddy_file"
cat >"$override_file" <<'EOF'
services:
  caddy:
    volumes:
      - ${SMOKE_CADDYFILE}:/etc/caddy/Caddyfile:ro
EOF

compose=(
  "$DOCKER_BIN" compose
  --project-directory "$ROOT_DIR"
  --project-name "$project_name"
  --env-file "$env_file"
  --file "$ROOT_DIR/docker-compose.yml"
  --file "$override_file"
)
readonly -a compose

secret_values=(
  "$POSTGRES_PASSWORD"
  "$DATABASE_URL"
  "$JWT_SECRET"
  "$PAIRING_CODE_PEPPER"
  "$MEDIA_DELIVERY_SECRET"
  "$MANIFEST_SIGNING_PRIVATE_KEY"
  "$MINIO_ROOT_PASSWORD"
  "$S3_SECRET_ACCESS_KEY"
  "$SEED_ADMIN_PASSWORD"
)
readonly -a secret_values

sanitize_stream() {
  local line secret
  while IFS= read -r line || [[ -n "$line" ]]; do
    for secret in "${secret_values[@]}"; do
      line="${line//"$secret"/[REDACTED]}"
    done
    printf '%s\n' "$line"
  done
}

attempted_start=false
collect_failure_evidence() {
  "${compose[@]}" ps --all >"$EVIDENCE_DIR/compose-ps.txt" 2>&1 || true
  "${compose[@]}" logs --no-color --tail 200 2>&1 |
    sanitize_stream >"$EVIDENCE_DIR/compose-logs.txt" || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if ((status != 0)); then
    collect_failure_evidence
    printf 'Compose runtime smoke: failed (exit %s)\n' "$status" \
      >"$EVIDENCE_DIR/result.txt"
    printf '%s\n' '--- sanitized Compose diagnostics (last 200 lines) ---' >&2
    tail -n 200 "$EVIDENCE_DIR/compose-logs.txt" >&2 || true
  fi
  if [[ "$attempted_start" == true ]]; then
    "${compose[@]}" down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1
  fi
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

assert_status() {
  local host="$1" path="$2" expected="$3" label="$4"
  local body="$work_dir/${label}.body"
  local headers="$work_dir/${label}.headers"
  local status
  status="$($CURL_BIN --silent --show-error --insecure \
    --resolve "$host:443:127.0.0.1" \
    --output "$body" --dump-header "$headers" --write-out '%{http_code}' \
    "https://$host$path")"
  [[ "$status" == "$expected" ]] || {
    echo "$label returned HTTP $status; expected $expected" >&2
    return 1
  }
}

assert_header() {
  local label="$1" header="$2"
  tr -d '\r' <"$work_dir/${label}.headers" | grep -qi "^${header}:" || {
    echo "$label did not return required $header header" >&2
    return 1
  }
}

"${compose[@]}" config --quiet
attempted_start=true
"${compose[@]}" up --detach --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS"

for service_port in \
  "postgres 5432" "redis 6379" "minio 9000" "minio 9001" \
  "api 3001" "console 8080" "player-web 8080"; do
  read -r service port <<<"$service_port"
  container_id="$("${compose[@]}" ps --quiet "$service")"
  [[ -n "$container_id" ]] || {
    echo "Could not resolve the $service container" >&2
    exit 1
  }
  bindings="$("$DOCKER_BIN" inspect "$container_id" \
    --format "{{json (index .NetworkSettings.Ports \"${port}/tcp\")}}")"
  [[ "$bindings" == null ]] || {
    echo "$service unexpectedly has host bindings for port $port: $bindings" >&2
    exit 1
  }
done
for caddy_port in 80 443; do
  published="$("${compose[@]}" port caddy "$caddy_port")"
  [[ -n "$published" ]] || {
    echo "Caddy does not publish required port $caddy_port" >&2
    exit 1
  }
done
[[ "$($DOCKER_BIN network inspect "${project_name}_backend" --format '{{.Internal}}')" == true ]] || {
  echo "Compose backend network is not internal" >&2
  exit 1
}

readonly media_body="ScreenGoblin private media runtime smoke"
readonly media_org_id="compose-media-org"
readonly media_screen_id="compose-media-screen"
readonly media_credential_id="compose-media-credential"
media_key_id="$(printf 'K%.0s' {1..43})"
readonly media_key_id
readonly media_asset_id="compose-media-asset"
media_checksum="$(printf '%s' "$media_body" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $2}')"
readonly media_checksum
readonly media_size="${#media_body}"
readonly media_storage_key="organizations/$media_org_id/assets/$media_asset_id/$media_checksum"

"${compose[@]}" run --rm --no-deps --entrypoint /bin/sh minio-init -ceu '
  mc alias set smoke http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  printf "%s" "$1" | mc pipe "smoke/$S3_BUCKET/$2" >/dev/null
' -- "$media_body" "$media_storage_key"

"${compose[@]}" exec -T postgres psql \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('$media_org_id', 'Compose private media', 'compose-private-media', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Screen" (
  "id", "organizationId", "name", "status", "orientation", "resolution",
  "tags", "installationId", "credentialGeneration", "createdAt", "updatedAt"
) VALUES (
  '$media_screen_id', '$media_org_id', 'Compose media screen', 'OFFLINE',
  'LANDSCAPE', '1920x1080', ARRAY[]::TEXT[], 'compose-media-installation',
  1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO "DeviceCredential" (
  "id", "organizationId", "screenId", "liveScreenId",
  "liveScreenOrganizationId", "keyId", "publicKeySpki", "algorithm",
  "securityLevel", "createdAt"
) VALUES (
  '$media_credential_id', '$media_org_id', '$media_screen_id', '$media_screen_id',
  '$media_org_id', '$media_key_id', decode(repeat('00', 80), 'hex'), 'ES256',
  'software', CURRENT_TIMESTAMP
);
SQL

anonymous_status="$("${compose[@]}" exec -T minio curl --silent \
  --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:9000/$S3_BUCKET/$media_storage_key")"
[[ "$anonymous_status" == "403" ]] || {
  echo "Anonymous MinIO object GET returned HTTP $anonymous_status; expected 403" >&2
  exit 1
}

mapfile -t media_capabilities < <(
  "${compose[@]}" exec -T api node --input-type=module -e '
    const [screenId, organizationId, keyId, assetId, storageKey, checksum, size] =
      process.argv.slice(1);
    const { issueMediaCapability } =
      await import("./apps/api/dist/media/delivery.js");
    const base = {
      screenId,
      organizationId,
      credentialKeyId: keyId,
      assetId,
      storageKey,
      mimeType: "text/plain",
      checksumSha256: checksum,
      sizeBytes: Number(size),
    };
    console.log(issueMediaCapability(
      { ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      process.env.MEDIA_DELIVERY_SECRET,
    ));
    console.log(issueMediaCapability(
      { ...base, expiresAt: new Date(Date.now() - 60_000).toISOString() },
      process.env.MEDIA_DELIVERY_SECRET,
    ));
  ' "$media_screen_id" "$media_org_id" "$media_key_id" "$media_asset_id" \
    "$media_storage_key" "$media_checksum" "$media_size"
)
(( ${#media_capabilities[@]} == 2 )) || {
  echo "API container did not issue the expected media capabilities" >&2
  exit 1
}
readonly valid_media_capability="${media_capabilities[0]}"
readonly expired_media_capability="${media_capabilities[1]}"

assert_status "$SCREEN_GOBLIN_HOST" "/health/live" 204 "api-live"
assert_status "$SCREEN_GOBLIN_HOST" "/health/ready" 404 "public-readiness"
assert_status "$SCREEN_GOBLIN_HOST" "/" 200 "console"
assert_status "$PLAYER_HOST" "/" 200 "player"
assert_status "$SCREEN_GOBLIN_HOST" "/media/runtime-smoke.txt" 404 "legacy-media-denied"
assert_status "$SCREEN_GOBLIN_HOST" \
  "/api/v1/device/media/$media_asset_id?capability=$valid_media_capability" \
  200 "private-media-valid"
[[ "$(cat "$work_dir/private-media-valid.body")" == "$media_body" ]] || {
  echo "Private media API returned unexpected bytes" >&2
  exit 1
}
assert_status "$SCREEN_GOBLIN_HOST" \
  "/api/v1/device/media/$media_asset_id?capability=${valid_media_capability}x" \
  404 "private-media-tampered"
assert_status "$SCREEN_GOBLIN_HOST" \
  "/api/v1/device/media/$media_asset_id?capability=$expired_media_capability" \
  404 "private-media-expired"

grep -q '<div id="root">' "$work_dir/console.body"
grep -q '<div id="root">' "$work_dir/player.body"
for label in console player; do
  assert_header "$label" "Content-Security-Policy"
  assert_header "$label" "X-Frame-Options"
  assert_header "$label" "Strict-Transport-Security"
  assert_header "$label" "X-Content-Type-Options"
done

"${compose[@]}" ps --all >"$EVIDENCE_DIR/compose-ps.txt"
cat >"$EVIDENCE_DIR/result.txt" <<EOF
Compose production-mode startup and health: passed
Caddy API, readiness isolation, Console, Player, headers, and legacy media denial: passed
Private MinIO anonymous denial and valid/tampered/expired API capability delivery: passed
Published-port and internal-backend-network assertions: passed
EOF

echo "Compose production-runtime smoke passed"
