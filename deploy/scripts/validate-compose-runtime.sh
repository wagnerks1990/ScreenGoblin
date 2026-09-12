#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly DOCKER_BIN="${DOCKER_BIN:-docker}"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly OPENSSL_BIN="${OPENSSL_BIN:-openssl}"
readonly WAIT_TIMEOUT_SECONDS="${COMPOSE_SMOKE_TIMEOUT_SECONDS:-240}"
readonly EVIDENCE_DIR="${COMPOSE_SMOKE_EVIDENCE_DIR:-$ROOT_DIR/compose-smoke-evidence}"
readonly DAST_IMAGE="${COMPOSE_DAST_IMAGE:-}"
readonly DAST_HOOK="$ROOT_DIR/deploy/scripts/zap-runtime-hooks.py"
readonly DAST_INVENTORY="$ROOT_DIR/deploy/scripts/zap-runtime-inventory.json"
readonly DAST_TMPFS_BYTES=268435456
readonly DAST_FILE_BLOCKS=524288

[[ "$WAIT_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] &&
  ((WAIT_TIMEOUT_SECONDS >= 30 && WAIT_TIMEOUT_SECONDS <= 900)) || {
  echo "COMPOSE_SMOKE_TIMEOUT_SECONDS must be between 30 and 900" >&2
  exit 2
}
if [[ -n "$DAST_IMAGE" && ! "$DAST_IMAGE" =~ ^[^[:space:]@]+:[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "COMPOSE_DAST_IMAGE must include an immutable tag and SHA-256 digest" >&2
  exit 2
fi
[[ ! -e "$EVIDENCE_DIR" ]] || {
  echo "Refusing to overwrite existing Compose smoke evidence: $EVIDENCE_DIR" >&2
  exit 2
}

command -v "$DOCKER_BIN" >/dev/null
command -v "$CURL_BIN" >/dev/null
command -v "$OPENSSL_BIN" >/dev/null
command -v awk >/dev/null
command -v sha256sum >/dev/null
if [[ -n "$DAST_IMAGE" ]]; then
  command -v node >/dev/null
  command -v timeout >/dev/null
fi

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
    networks:
      frontend:
      backend:
      dast:
        aliases:
          - signage.example.test
          - player.example.test
networks:
  dast:
    internal: true
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
dast_active=false

write_checksums() {
  (
    cd "$EVIDENCE_DIR"
    find . -type f ! -name SHA256SUMS -print0 |
      LC_ALL=C sort -z |
      xargs -0 sha256sum >SHA256SUMS
  )
}

collect_failure_evidence() {
  "${compose[@]}" ps --all >"$EVIDENCE_DIR/compose-ps.txt" 2>&1 || true
  if [[ "$dast_active" == false ]]; then
    "${compose[@]}" logs --no-color --tail 200 2>&1 |
      sanitize_stream >"$EVIDENCE_DIR/compose-logs.txt" || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if ((status != 0)); then
    collect_failure_evidence
    printf 'Compose runtime smoke and unauthenticated DAST: failed (exit %s)\n' "$status" \
      >"$EVIDENCE_DIR/result.txt"
    write_checksums || true
    if [[ "$dast_active" == false ]]; then
      printf '%s\n' '--- sanitized Compose diagnostics (last 200 lines) ---' >&2
      tail -n 200 "$EVIDENCE_DIR/compose-logs.txt" >&2 || true
    fi
  fi
  "$DOCKER_BIN" rm --force \
    "${project_name}-zap-console-api" "${project_name}-zap-player" \
    >/dev/null 2>&1 || true
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

assert_csp() {
  local label="$1" expected_connect_origin="${2:-}"
  local value
  value="$(tr -d '\r' <"$work_dir/${label}.headers" |
    awk 'BEGIN { IGNORECASE=1 } /^Content-Security-Policy:/ { sub(/^[^:]+:[[:space:]]*/, ""); print; exit }')"
  [[ -n "$value" ]] || {
    echo "$label did not return a Content-Security-Policy value" >&2
    return 1
  }
  ! printf '%s\n' "$value" | grep -Fq '*' &&
    ! printf '%s\n' "$value" |
      grep -Eq '(^|[[:space:]])https?:([[:space:];]|$)|http://' || {
    echo "$label CSP contains a wildcard or scheme-wide source" >&2
    return 1
  }
  [[ "$value" == *"frame-src 'none'"* ]] || {
    echo "$label CSP does not deny frames" >&2
    return 1
  }
  [[ "$value" == *"style-src 'self';"* && "$value" != *"unsafe-inline"* ]] || {
    echo "$label CSP does not restrict styles to packaged resources" >&2
    return 1
  }
  if [[ -n "$expected_connect_origin" ]]; then
    [[ "$value" == *"connect-src 'self' $expected_connect_origin;"* ]] || {
      echo "$label CSP does not contain the exact required API origin" >&2
      return 1
    }
  else
    [[ "$value" == *"connect-src 'self';"* ]] || {
      echo "$label CSP connect policy is not self-only" >&2
      return 1
    }
  fi
}

assert_public_runtime_security() {
  local trace_status cors_headers malformed_body malformed_status reflected_body
  trace_status="$($CURL_BIN --silent --show-error --insecure \
    --resolve "$SCREEN_GOBLIN_HOST:443:127.0.0.1" \
    --request TRACE --output /dev/null --write-out '%{http_code}' \
    "https://$SCREEN_GOBLIN_HOST/api/v1/auth/login")"
  [[ "$trace_status" =~ ^(400|404|405|501)$ ]] || {
    echo "TRACE reached the public API with unexpected HTTP $trace_status" >&2
    return 1
  }

  cors_headers="$work_dir/cors.headers"
  "$CURL_BIN" --silent --show-error --insecure \
    --resolve "$SCREEN_GOBLIN_HOST:443:127.0.0.1" \
    --header "Origin: https://untrusted.example.test" \
    --dump-header "$cors_headers" --output /dev/null \
    "https://$SCREEN_GOBLIN_HOST/health/live"
  ! tr -d '\r' <"$cors_headers" |
    grep -qi '^Access-Control-Allow-Origin: https://untrusted\.example\.test$' || {
    echo "Public API reflected an untrusted CORS origin" >&2
    return 1
  }

  malformed_body="$work_dir/malformed-auth.body"
  malformed_status="$($CURL_BIN --silent --show-error --insecure \
    --resolve "$SCREEN_GOBLIN_HOST:443:127.0.0.1" \
    --request POST --header "Content-Type: application/json" \
    --data '{"email":' --output "$malformed_body" --write-out '%{http_code}' \
    "https://$SCREEN_GOBLIN_HOST/api/v1/auth/login")"
  [[ "$malformed_status" == 400 ]] || {
    echo "Malformed authentication JSON returned HTTP $malformed_status; expected 400" >&2
    return 1
  }
  ! grep -Eqi 'node_modules|postgresql://|prisma|JWT_SECRET|MEDIA_DELIVERY_SECRET|(^|[^a-z])stack([^a-z]|$)| at [A-Za-z0-9_$]+ \(' \
    "$malformed_body" || {
    echo "Malformed authentication response exposed an internal error marker" >&2
    return 1
  }

  reflected_body="$work_dir/reflection.body"
  "$CURL_BIN" --silent --show-error --insecure \
    --resolve "$SCREEN_GOBLIN_HOST:443:127.0.0.1" \
    --output "$reflected_body" \
    "https://$SCREEN_GOBLIN_HOST/api/v1/not-found?probe=%3Cscript%3Ealert%281%29%3C%2Fscript%3E"
  ! grep -Fqi '<script>alert(1)</script>' "$reflected_body" || {
    echo "Public API reflected an executable probe payload" >&2
    return 1
  }
}

emit_zap_diagnostics() {
  local scan_log="$1"
  echo "ZAP sanitized diagnostic classes and counts:" >&2
  {
    grep -E \
      '^((FAIL-NEW|FAIL-INPROG|WARN-NEW|WARN-INPROG|INFO|PASS): [0-9]+)([[:space:]]+(FAIL-NEW|FAIL-INPROG|WARN-NEW|WARN-INPROG|INFO|PASS): [0-9]+)*$' \
      "$scan_log" || true
    grep -E \
      '^DAST-HOOK-PHASE: (seed-start|seed-complete|coverage-start|coverage-complete)$|^ERROR <class '\''[[:alpha:]_][[:alnum:]_.]*(Exception|Error)'\''>$' \
      "$scan_log" || true
    grep -Eo \
      'java\.(io|net|lang|nio\.[[:alnum:]_.]+)\.[[:alnum:]_]+(Exception|Error)|org\.zaproxy\.[[:alnum:]_.]+Exception' \
      "$scan_log" || true
    for marker in \
      OutOfMemoryError 'Read-only file system' 'Permission denied' \
      'Address already in use' 'File size limit exceeded' 'No URLs found'; do
      grep -Fq "$marker" "$scan_log" && echo "$marker" || true
    done
  } | LC_ALL=C sort -u | sed 's/^/  /' >&2
}

run_zap_scan() {
  local surface="$1" target="$2"
  local raw_dir="$work_dir/zap-$surface"
  local raw_report="$raw_dir/report.json"
  local raw_coverage="$raw_dir/seed-coverage.json"
  local scan_log="$raw_dir/scan.log"
  local scan_status summary_status scanner_uid scanner_gid container_name
  scanner_uid="$(id -u)"
  scanner_gid="$(id -g)"
  [[ "$scanner_uid" =~ ^[0-9]+$ && "$scanner_gid" =~ ^[0-9]+$ ]] &&
    ((scanner_uid > 0)) || {
    echo "Refusing to run the DAST scanner as root or with an invalid host identity" >&2
    return 1
  }
  container_name="${project_name}-zap-${surface}"
  install -d -m 0700 "$raw_dir"
  : >"$raw_report"
  : >"$raw_coverage"
  set +e
  (
    ulimit -f "$DAST_FILE_BLOCKS"
    exec timeout --signal=TERM --kill-after=30s 12m \
    "$DOCKER_BIN" run --rm --name "$container_name" --pull never \
      --user "$scanner_uid:$scanner_gid" \
      --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
      --tmpfs "/zap/wrk:rw,noexec,nosuid,nodev,size=${DAST_TMPFS_BYTES},uid=${scanner_uid},gid=${scanner_gid},mode=0700" \
      --env HOME=/zap/wrk \
      --env XDG_CACHE_HOME=/zap/wrk/.cache \
      --env XDG_CONFIG_HOME=/zap/wrk/.config \
      --env XDG_DATA_HOME=/zap/wrk/.local/share \
      --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --pids-limit 512 \
      --memory 2g \
      --cpus 2 \
      --ulimit "fsize=$DAST_TMPFS_BYTES:$DAST_TMPFS_BYTES" \
      --network "${project_name}_dast" \
      --workdir /zap/wrk \
      --mount "type=bind,src=$DAST_HOOK,dst=/zap/runtime-hooks.py,readonly" \
      --mount "type=bind,src=$DAST_INVENTORY,dst=/zap/runtime-inventory.json,readonly" \
      --mount "type=bind,src=$raw_report,dst=/zap/wrk/report.json" \
      --mount "type=bind,src=$raw_coverage,dst=/zap/wrk/seed-coverage.json" \
      "$DAST_IMAGE" \
      zap-full-scan.py -t "$target" -m 1 -T 8 \
        -J report.json -s --hook=/zap/runtime-hooks.py \
        -z "-silent -dir /zap/wrk/.ZAP -config start.checkForUpdates=false" \
  ) >"$scan_log" 2>&1
  scan_status=$?
  "$DOCKER_BIN" rm --force "$container_name" >/dev/null 2>&1 || true
  set -e

  [[ -s "$raw_report" ]] || {
    echo "ZAP did not emit a report for $surface (exit $scan_status)" >&2
    emit_zap_diagnostics "$scan_log"
    return 1
  }
  [[ -s "$raw_coverage" ]] || {
    echo "ZAP did not emit seed coverage for $surface" >&2
    return 1
  }
  case "$scan_status" in
    0 | 1 | 2) ;;
    *)
      echo "ZAP scanner failed operationally on $surface (exit $scan_status)" >&2
      emit_zap_diagnostics "$scan_log"
      return 1
      ;;
  esac
  set +e
  node "$ROOT_DIR/deploy/scripts/summarize-zap-report.mjs" \
    "$raw_report" "$EVIDENCE_DIR/zap-$surface.json" "$surface" "$DAST_IMAGE" \
    "$target" "$raw_coverage" "$DAST_INVENTORY"
  summary_status=$?
  set -e
  if ((summary_status != 0)); then
    echo "Validated ZAP evidence blocked $surface (exit $summary_status)" >&2
    return "$summary_status"
  fi
  if ((scan_status != 0)); then
    echo "ZAP wrapper returned finding status $scan_status on $surface; validated retained report severity is authoritative" >&2
    emit_zap_diagnostics "$scan_log"
  fi
}

run_unauthenticated_dast() {
  [[ -n "$DAST_IMAGE" ]] || return 0
  dast_active=true
  "$DOCKER_BIN" pull "$DAST_IMAGE" >/dev/null
  "$DOCKER_BIN" image inspect "$DAST_IMAGE" \
    --format '{{join .RepoDigests "\n"}}' |
    grep -Fq "@${DAST_IMAGE##*@}" || {
    echo "Pulled DAST image did not resolve to the required digest" >&2
    return 1
  }
  assert_public_runtime_security
  run_zap_scan "console-api" "https://$SCREEN_GOBLIN_HOST"
  run_zap_scan "player" "https://$PLAYER_HOST"
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
readonly enrollment_screen_id="compose-enrollment-screen"
readonly media_credential_id="compose-media-credential"
readonly media_user_id="compose-media-user"
readonly media_membership_id="compose-media-membership"
readonly media_playlist_id="compose-media-playlist"
readonly media_playlist_item_id="compose-media-playlist-item"
readonly media_schedule_id="compose-media-schedule"
readonly media_release_id="compose-media-release"
readonly media_assignment_id="compose-media-assignment"
media_key_id="$(printf 'K%.0s' {1..43})"
readonly media_key_id
readonly media_asset_id="compose-media-asset"
media_checksum="$(printf '%s' "$media_body" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $2}')"
readonly media_checksum
readonly media_size="${#media_body}"
readonly media_storage_key="organizations/$media_org_id/assets/$media_asset_id/$media_checksum"
readonly media_snapshot_timestamp="2026-09-12T00:00:00.000Z"
readonly media_schedule_starts_at="2020-01-01T00:00:00.000Z"
readonly media_schedule_ends_at="2099-01-01T00:00:00.000Z"

media_password_hash="$("${compose[@]}" exec -T api node --input-type=module -e '
  import bcrypt from "bcryptjs";
  process.stdout.write(await bcrypt.hash(process.argv[1], 12));
' "$SEED_ADMIN_PASSWORD")"
readonly media_password_hash

mapfile -t media_snapshot_digests < <(
  "${compose[@]}" run --rm --no-deps --entrypoint node api --input-type=module -e '
    const [playlistId, playlistItemId, assetId, storageKey, checksum, size,
      screenId, timestamp, startsAt, endsAt, assignmentId] = process.argv.slice(1);
    const canonical = await import("./apps/api/dist/releases/canonical.js");
    const releaseDigest = canonical.releaseSnapshotDigest({
      schemaVersion: 1,
      sourcePlaylistId: playlistId,
      sourcePlaylistUpdatedAt: timestamp,
      playlistName: "Compose playlist",
      playlistDescription: "Capability authorization fixture",
      items: [{
        id: playlistItemId,
        asset: {
          id: assetId,
          name: "Compose media",
          kind: "image",
          mimeType: "image/png",
          url: "https://signage.example.test/media/compose.png",
          storageKey,
          checksumSha256: checksum,
          sizeBytes: Number(size),
          createdAt: timestamp,
        },
        position: 0,
        durationSeconds: 15,
      }],
    });
    const schedule = {
      name: "Compose schedule",
      priority: "normal",
      startsAt,
      endsAt,
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
    };
    console.log(releaseDigest);
    console.log(canonical.assignmentSnapshotDigest(
      canonical.canonicalAssignmentSnapshot({
        releaseDigestSha256: releaseDigest,
        state: "ASSIGNED",
        schedule,
        screenIds: [screenId],
      }),
    ));
    console.log(canonical.assignmentSnapshotDigest(
      canonical.canonicalAssignmentSnapshot({
        releaseDigestSha256: releaseDigest,
        state: "WITHDRAWN",
        schedule,
        screenIds: [screenId],
        previousAssignmentId: assignmentId,
      }),
    ));
  ' "$media_playlist_id" "$media_playlist_item_id" "$media_asset_id" \
    "$media_storage_key" "$media_checksum" "$media_size" "$media_screen_id" \
    "$media_snapshot_timestamp" "$media_schedule_starts_at" \
    "$media_schedule_ends_at" "$media_assignment_id"
)
(( ${#media_snapshot_digests[@]} == 3 )) || {
  echo "API container did not derive the expected frozen snapshot digests" >&2
  exit 1
}
readonly media_release_digest="${media_snapshot_digests[0]}"
readonly media_assignment_digest="${media_snapshot_digests[1]}"
readonly media_withdrawal_digest="${media_snapshot_digests[2]}"

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
INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
VALUES ('$media_user_id', 'compose-media@example.test', 'Compose media operator', '$media_password_hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Membership" ("id", "organizationId", "userId", "role")
VALUES ('$media_membership_id', '$media_org_id', '$media_user_id', 'OWNER');
INSERT INTO "Screen" (
  "id", "organizationId", "name", "status", "orientation", "resolution",
  "tags", "credentialGeneration", "createdAt", "updatedAt"
) VALUES (
  '$enrollment_screen_id', '$media_org_id', 'Compose enrollment target',
  'OFFLINE', 'LANDSCAPE', '1920x1080', ARRAY[]::TEXT[], 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO "MediaAsset" ("id", "organizationId", "storageKey", "name", "kind", "mimeType", "url", "checksumSha256", "sizeBytes", "durationSeconds", "createdAt", "updatedAt")
VALUES ('$media_asset_id', '$media_org_id', '$media_storage_key', 'Compose media', 'IMAGE', 'image/png', 'https://signage.example.test/media/compose.png', '$media_checksum', '$media_size'::bigint, 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Playlist" ("id", "organizationId", "name", "description", "createdAt", "updatedAt")
VALUES ('$media_playlist_id', '$media_org_id', 'Compose playlist', 'Capability authorization fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "PlaylistItem" ("id", "organizationId", "playlistId", "assetId", "position", "durationSeconds")
VALUES ('$media_playlist_item_id', '$media_org_id', '$media_playlist_id', '$media_asset_id', 0, 15);
INSERT INTO "Schedule" ("id", "organizationId", "playlistId", "name", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "createdAt", "updatedAt")
VALUES ('$media_schedule_id', '$media_org_id', '$media_playlist_id', 'Compose schedule', 'NORMAL', '$media_schedule_starts_at', '$media_schedule_ends_at', 'UTC', ARRAY[]::INTEGER[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "ScheduleTarget" ("organizationId", "scheduleId", "screenId")
VALUES ('$media_org_id', '$media_schedule_id', '$media_screen_id');
INSERT INTO "PublishedRelease" ("id", "organizationId", "sourcePlaylistId", "sourcePlaylistName", "sourcePlaylistDescription", "sourcePlaylistUpdatedAt", "digestSha256", "createdById", "createdAt")
VALUES ('$media_release_id', '$media_org_id', '$media_playlist_id', 'Compose playlist', 'Capability authorization fixture', '$media_snapshot_timestamp', '$media_release_digest', '$media_user_id', CURRENT_TIMESTAMP);
INSERT INTO "FrozenReleaseItem" ("id", "organizationId", "releaseId", "sourcePlaylistItemId", "sourceAssetId", "assetName", "assetKind", "assetMimeType", "assetUrl", "assetStorageKey", "assetChecksumSha256", "assetSizeBytes", "assetCreatedAt", "position", "durationSeconds", "createdAt")
VALUES ('compose-media-frozen-item', '$media_org_id', '$media_release_id', '$media_playlist_item_id', '$media_asset_id', 'Compose media', 'IMAGE', 'image/png', 'https://signage.example.test/media/compose.png', '$media_storage_key', '$media_checksum', '$media_size'::bigint, '$media_snapshot_timestamp', 0, 15, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "createdAt")
VALUES ('$media_assignment_id', '$media_org_id', '$media_release_id', '$media_schedule_id', 'ASSIGNED', '$media_assignment_digest', '$media_user_id', 'Compose schedule', 'NORMAL', '$media_schedule_starts_at', '$media_schedule_ends_at', 'UTC', ARRAY[]::INTEGER[], true, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('$media_org_id', '$media_assignment_id', '$media_screen_id', '$media_screen_id', '$media_org_id');
SQL

login_status="$($CURL_BIN --silent --show-error --insecure \
  --resolve "$SCREEN_GOBLIN_HOST:443:127.0.0.1" \
  --request POST --header "Content-Type: application/json" \
  --data "{\"email\":\"compose-media@example.test\",\"password\":\"$SEED_ADMIN_PASSWORD\"}" \
  --output "$work_dir/enrollment-login.json" --write-out '%{http_code}' \
  "https://$SCREEN_GOBLIN_HOST/api/v1/auth/login")"
[[ "$login_status" == 200 ]] || {
  echo "Enrollment fixture login returned HTTP $login_status" >&2
  exit 1
}
management_token="$("${compose[@]}" exec -T api node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const value = JSON.parse(readFileSync(0, "utf8")).accessToken;
  if (typeof value !== "string" || value.length < 20) process.exit(2);
  process.stdout.write(value);
' < "$work_dir/enrollment-login.json")"
readonly management_token
untargeted_status="$($CURL_BIN --silent --show-error --insecure \
  --resolve "$SCREEN_GOBLIN_HOST:443:127.0.0.1" \
  --request POST --header "Authorization: Bearer $management_token" \
  --output "$work_dir/untargeted-enrollment.body" --write-out '%{http_code}' \
  "https://$SCREEN_GOBLIN_HOST/api/v1/pairing-codes")"
[[ "$untargeted_status" == 410 ]] || {
  echo "Unbound proof-v1 enrollment returned HTTP $untargeted_status; expected 410" >&2
  exit 1
}
readonly enrollment_idempotency_key="11111111-1111-4111-8111-111111111111"
for replay in first replay; do
  enrollment_status="$($CURL_BIN --silent --show-error --insecure \
    --resolve "$SCREEN_GOBLIN_HOST:443:127.0.0.1" \
    --request POST --header "Authorization: Bearer $management_token" \
    --header "Idempotency-Key: $enrollment_idempotency_key" \
    --header "Content-Type: application/json" \
    --data '{"reason":"Compose targeted enrollment boundary"}' \
    --output "$work_dir/enrollment-$replay.json" --write-out '%{http_code}' \
    "https://$SCREEN_GOBLIN_HOST/api/v1/screens/$enrollment_screen_id/device-enrollment")"
  [[ "$enrollment_status" == 201 ]] || {
    echo "Targeted enrollment $replay returned HTTP $enrollment_status; expected 201" >&2
    exit 1
  }
done
cmp "$work_dir/enrollment-first.json" "$work_dir/enrollment-replay.json"
enrollment_secret="$("${compose[@]}" exec -T api node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const value = JSON.parse(readFileSync(0, "utf8")).code;
  if (!/^[0-9]{6}$/.test(value)) process.exit(2);
  process.stdout.write(value);
' < "$work_dir/enrollment-first.json")"
enrollment_authority_count="$(
  "${compose[@]}" exec -T postgres psql \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -At \
    --set enrollment_secret="$enrollment_secret" \
    --set enrollment_key="$enrollment_idempotency_key" \
    --set enrollment_org="$media_org_id" \
    --set enrollment_screen="$enrollment_screen_id" \
    --file=- <<'SQL'
SELECT count(*) FROM "PairingCode" pairing_grant
JOIN "Membership" membership
  ON membership."id" = pairing_grant."authorizedByMembershipId"
JOIN "User" issuer ON issuer."id" = pairing_grant."authorizedByUserId"
JOIN "IdempotencyRecord" replay
  ON replay."organizationId" = pairing_grant."organizationId"
 AND replay.operation = 'SCREEN_ENROLLMENT_CREATE'
WHERE pairing_grant."organizationId" = :'enrollment_org'
  AND pairing_grant."targetScreenId" = :'enrollment_screen'
  AND pairing_grant."targetScreenReferenceId" = :'enrollment_screen'
  AND pairing_grant."targetOrganizationId" = :'enrollment_org'
  AND pairing_grant."authorizedByAuthenticationEpoch" = issuer."authenticationEpoch"
  AND pairing_grant."authorizedByAuthorizationEpoch" = membership."authorizationEpoch"
  AND pairing_grant."codeHash" <> :'enrollment_secret'
  AND replay."keyHash" <> :'enrollment_key'
  AND replay."responseBody"::text NOT LIKE '%' || :'enrollment_secret' || '%'
  AND pairing_grant."expiresAt" <= CURRENT_TIMESTAMP + INTERVAL '11 minutes';
SQL
)"
[[ "$enrollment_authority_count" == 1 ]] || {
  echo "Targeted enrollment authority was not exactly tenant/issuer/idempotency bound" >&2
  exit 1
}

anonymous_status="$("${compose[@]}" exec -T minio curl --silent \
  --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:9000/$S3_BUCKET/$media_storage_key")"
[[ "$anonymous_status" == "403" ]] || {
  echo "Anonymous MinIO object GET returned HTTP $anonymous_status; expected 403" >&2
  exit 1
}

mapfile -t media_capabilities < <(
  "${compose[@]}" exec -T api node --input-type=module -e '
    const [screenId, organizationId, keyId, assignmentId, assetId, storageKey,
      checksum, size, assignmentDigestSha256] =
      process.argv.slice(1);
    const { issueMediaCapability } =
      await import("./apps/api/dist/media/delivery.js");
    const base = {
      screenId,
      organizationId,
      credentialKeyId: keyId,
      assignmentId,
      assignmentDigestSha256,
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
  ' "$media_screen_id" "$media_org_id" "$media_key_id" "$media_assignment_id" "$media_asset_id" \
    "$media_storage_key" "$media_checksum" "$media_size" "$media_assignment_digest"
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
"${compose[@]}" exec -T postgres psql \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "previousAssignmentId", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "createdAt")
VALUES ('compose-media-withdrawal', '$media_org_id', '$media_release_id', '$media_schedule_id', 'WITHDRAWN', '$media_withdrawal_digest', '$media_assignment_id', '$media_user_id', 'Compose schedule', 'NORMAL', '$media_schedule_starts_at', '$media_schedule_ends_at', 'UTC', ARRAY[]::INTEGER[], true, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('$media_org_id', 'compose-media-withdrawal', '$media_screen_id', '$media_screen_id', '$media_org_id');
SQL
assert_status "$SCREEN_GOBLIN_HOST" \
  "/api/v1/device/media/$media_asset_id?capability=$valid_media_capability" \
  404 "private-media-withdrawn"
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
assert_csp "console"
assert_csp "player" "https://$SCREEN_GOBLIN_HOST"

run_unauthenticated_dast
if [[ -n "$DAST_IMAGE" ]]; then
  dast_result="passed"
else
  dast_result="not requested"
fi
readonly dast_result

"${compose[@]}" ps --all >"$EVIDENCE_DIR/compose-ps.txt"
cat >"$EVIDENCE_DIR/result.txt" <<EOF
Compose production-mode startup and health: passed
Caddy API, readiness isolation, Console, Player, headers, and legacy media denial: passed
Proof-v1 unbound enrollment denial and targeted issuer/idempotency binding: passed
Private MinIO denial and valid/withdrawn/tampered/expired API capability delivery: passed
Published-port and internal-backend-network assertions: passed
Unauthenticated public-surface method, CORS, error-reflection, and pinned ZAP checks: $dast_result
EOF
write_checksums
(
  cd "$EVIDENCE_DIR"
  sha256sum --check SHA256SUMS
)

echo "Compose production-runtime smoke passed; unauthenticated DAST $dast_result"
