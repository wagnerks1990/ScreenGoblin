#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
command -v docker >/dev/null
command -v sha256sum >/dev/null
command -v stat >/dev/null

readonly POSTGRES_FIXTURE="${POSTGRES_FIXTURE_IMAGE:-postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73}"
readonly MINIO_FIXTURE="${MINIO_FIXTURE_IMAGE:-quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e}"
readonly MC_FIXTURE="${MC_FIXTURE_IMAGE:-quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3}"
readonly ALPINE_FIXTURE="${ALPINE_FIXTURE_IMAGE:-alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce}"
readonly ROLLBACK_DOCKERFILE="${ROLLBACK_DOCKERFILE:-deploy/docker/api.Dockerfile}"
readonly EVIDENCE_DIR="${RECOVERY_EVIDENCE_DIR:-recovery-evidence}"
readonly SOURCE_COMMIT="${RECOVERY_SOURCE_COMMIT:-${GITHUB_SHA:-local-uncommitted-source}}"
readonly DATABASE_URL="postgresql://screengoblin:recovery-test-only@postgres:5432/screengoblin?schema=public"
readonly STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

require_digest() {
  local image="$1"
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || {
    echo "Recovery fixture images must use an explicit sha256 digest: $image" >&2
    exit 2
  }
}

elapsed_ms() {
  local started_ns="$1"
  local ended_ns
  ended_ns="$(date +%s%N)"
  printf '%s\n' "$(( (ended_ns - started_ns) / 1000000 ))"
}

require_digest "$POSTGRES_FIXTURE"
require_digest "$MINIO_FIXTURE"
require_digest "$MC_FIXTURE"
require_digest "$ALPINE_FIXTURE"

if [[ -e "$EVIDENCE_DIR" ]]; then
  echo "Refusing to overwrite existing recovery evidence: $EVIDENCE_DIR" >&2
  exit 2
fi
mkdir -p "$EVIDENCE_DIR"

work_dir="$(mktemp -d)"
network="screengoblin-recovery-${RANDOM}-${RANDOM}"
pg_container="${network}-postgres"
minio_container="${network}-minio"
cleanup() {
  docker rm -f "$pg_container" "$minio_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

resolve_fixture() {
  local tag="$1" digest
  docker pull "$tag" >/dev/null
  digest="$(docker image inspect "$tag" --format '{{index .RepoDigests 0}}')"
  [[ "$digest" == *@sha256:* ]] || {
    echo "Could not resolve immutable digest for $tag" >&2
    exit 1
  }
  printf '%s\n' "$digest"
}

pg_image="$(resolve_fixture "$POSTGRES_FIXTURE")"
minio_image="$(resolve_fixture "$MINIO_FIXTURE")"
mc_image="$(resolve_fixture "$MC_FIXTURE")"
alpine_image="$(resolve_fixture "$ALPINE_FIXTURE")"
printf '%s\n' "$pg_image" "$minio_image" "$mc_image" "$alpine_image" \
  > "$work_dir/fixture-digests.txt"
cp "$work_dir/fixture-digests.txt" "$EVIDENCE_DIR/fixture-image-digests.txt"

printf 'ScreenGoblin referenced recovery media\n' > "$work_dir/object.txt"
object_sha256="$(sha256sum "$work_dir/object.txt" | cut -d ' ' -f 1)"
object_size="$(stat --format=%s "$work_dir/object.txt")"
migration_directory_count="$(
  find apps/api/prisma/migrations -mindepth 1 -maxdepth 1 -type d |
    wc -l | tr -d ' '
)"
[[ "$migration_directory_count" =~ ^[1-9][0-9]*$ ]]

docker network create "$network" >/dev/null
docker run --detach --pull never --name "$pg_container" --network "$network" \
  --network-alias postgres \
  --env POSTGRES_PASSWORD=recovery-test-only --env POSTGRES_USER=screengoblin \
  --env POSTGRES_DB=screengoblin "$pg_image" >/dev/null
for attempt in {1..60}; do
  if docker exec "$pg_container" psql -U screengoblin -d screengoblin \
    -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  [[ "$attempt" -lt 60 ]] || {
    echo "PostgreSQL fixture did not become ready" >&2
    exit 1
  }
  sleep 1
done

migration_started_ns="$(date +%s%N)"
docker build --pull --target build --file "$ROLLBACK_DOCKERFILE" \
  --tag screengoblin/recovery-migrate:test .
docker run --rm --pull never --network "$network" \
  --env DATABASE_URL="$DATABASE_URL" \
  screengoblin/recovery-migrate:test \
  sh -c 'mv apps/api/prisma/migrations/20260912162000_targeted_initial_enrollment /tmp/targeted-initial-enrollment && npm run prisma:migrate -w @screengoblin/api'
docker exec -i "$pg_container" psql -U screengoblin -d screengoblin \
  -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('upgrade-enrollment-org', 'Upgrade enrollment fixture', 'upgrade-enrollment-fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "PairingCode" ("id", "organizationId", "codeHash", "status", "expiresAt", "claimedAt", "createdAt")
VALUES
  ('upgrade-pending-grant', 'upgrade-enrollment-org', repeat('7', 64), 'PENDING', CURRENT_TIMESTAMP + INTERVAL '5 minutes', NULL, CURRENT_TIMESTAMP),
  ('upgrade-claimed-grant', 'upgrade-enrollment-org', repeat('8', 64), 'CLAIMED', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "PairingAttempt" ("id", "organizationId", "pairingCodeId", "keyId", "publicKeySpki", "algorithm", "securityLevel", "challengeHashSha256", "transcriptDigestSha256", "expiresAt", "createdAt")
VALUES (repeat('u', 43), 'upgrade-enrollment-org', 'upgrade-pending-grant', repeat('v', 43), decode(repeat('cd', 91), 'hex'), 'ES256', 'software', repeat('3', 64), repeat('4', 64), CURRENT_TIMESTAMP + INTERVAL '30 seconds', CURRENT_TIMESTAMP);
COMMIT;
SQL
docker run --rm --pull never --network "$network" \
  --env DATABASE_URL="$DATABASE_URL" \
  screengoblin/recovery-migrate:test \
  npm run prisma:migrate -w @screengoblin/api
upgrade_authority_result="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT pending.status::text || '|' || (attempt.\"cancelledAt\" IS NOT NULL)::text || '|' || claimed.status::text FROM \"PairingCode\" pending JOIN \"PairingAttempt\" attempt ON attempt.\"pairingCodeId\" = pending.id CROSS JOIN \"PairingCode\" claimed WHERE pending.id = 'upgrade-pending-grant' AND claimed.id = 'upgrade-claimed-grant'"
)"
[[ "$upgrade_authority_result" == "REVOKED|true|CLAIMED" ]]
migration_duration_ms="$(elapsed_ms "$migration_started_ns")"
applied_migration_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
)"
[[ "$applied_migration_count" == "$migration_directory_count" ]] || {
  echo "Applied migration count does not match checked-in migration directories" >&2
  exit 1
}

docker exec -i "$pg_container" psql -U screengoblin -d screengoblin \
  -v ON_ERROR_STOP=1 -v object_sha256="$object_sha256" \
  -v object_size="$object_size" >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('recovery-org', 'Recovery fixture', 'recovery-fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
VALUES ('recovery-user', 'recovery@example.test', 'Recovery operator', 'non-secret-fixture-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Membership" ("id", "organizationId", "userId", "role")
VALUES ('recovery-membership', 'recovery-org', 'recovery-user', 'OWNER');
INSERT INTO "UserSession" ("id", "organizationId", "userId", "tokenHash", "authenticationEpoch", "authorizationEpoch", "expiresAt", "createdAt")
VALUES ('recovery-session', 'recovery-org', 'recovery-user', repeat('c', 64), 0, 0, '2099-01-01T00:00:00Z', CURRENT_TIMESTAMP);
INSERT INTO "Location" ("id", "organizationId", "name", "createdAt", "updatedAt")
VALUES ('recovery-location', 'recovery-org', 'Recovery location', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Screen" ("id", "organizationId", "name", "location", "locationId", "status", "orientation", "resolution", "tags", "createdAt", "updatedAt")
VALUES ('recovery-screen', 'recovery-org', 'Recovery display', 'CI fixture', 'recovery-location', 'OFFLINE', 'LANDSCAPE', '1920x1080', ARRAY['recovery'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "PairingCode" ("id", "organizationId", "purpose", "targetScreenId", "targetScreenReferenceId", "targetOrganizationId", "expectedGeneration", "authorizedByUserId", "authorizedByMembershipId", "authorizedByAuthenticationEpoch", "authorizedByAuthorizationEpoch", "requestReason", "codeHash", "status", "expiresAt", "createdAt")
VALUES ('recovery-enrollment-grant', 'recovery-org', 'NEW_SCREEN', 'recovery-screen', 'recovery-screen', 'recovery-org', 0, 'recovery-user', 'recovery-membership', 0, 0, 'Recovery-safe enrollment fixture', repeat('f', 64), 'PENDING', '2099-01-01T00:00:00Z', CURRENT_TIMESTAMP);
INSERT INTO "PairingAttempt" ("id", "organizationId", "pairingCodeId", "keyId", "publicKeySpki", "algorithm", "securityLevel", "challengeHashSha256", "transcriptDigestSha256", "expiresAt", "createdAt")
VALUES (repeat('a', 43), 'recovery-org', 'recovery-enrollment-grant', repeat('k', 43), decode(repeat('ab', 91), 'hex'), 'ES256', 'software', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '30 seconds', CURRENT_TIMESTAMP);
INSERT INTO "MediaAsset" ("id", "organizationId", "storageKey", "name", "kind", "mimeType", "url", "checksumSha256", "sizeBytes", "durationSeconds", "createdAt", "updatedAt")
VALUES ('recovery-media', 'recovery-org', 'organizations/recovery-org/assets/recovery-media/' || :'object_sha256', 'Recovery media', 'IMAGE', 'image/png', 'https://media.example.test/recovery/object.txt', :'object_sha256', :'object_size'::bigint, 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Playlist" ("id", "organizationId", "name", "description", "createdAt", "updatedAt")
VALUES ('recovery-playlist', 'recovery-org', 'Recovery playlist', 'Restore relation fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "PlaylistItem" ("id", "organizationId", "playlistId", "assetId", "position", "durationSeconds")
VALUES ('recovery-playlist-item', 'recovery-org', 'recovery-playlist', 'recovery-media', 0, 15);
INSERT INTO "Schedule" ("id", "organizationId", "playlistId", "name", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "createdAt", "updatedAt")
VALUES ('recovery-schedule', 'recovery-org', 'recovery-playlist', 'Recovery schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "ScheduleTarget" ("organizationId", "scheduleId", "screenId")
VALUES ('recovery-org', 'recovery-schedule', 'recovery-screen');
INSERT INTO "PublishedRelease" ("id", "organizationId", "sourcePlaylistId", "sourcePlaylistName", "sourcePlaylistDescription", "sourcePlaylistUpdatedAt", "digestSha256", "createdById", "createdAt")
VALUES ('recovery-release', 'recovery-org', 'recovery-playlist', 'Recovery playlist', 'Restore relation fixture', CURRENT_TIMESTAMP, repeat('a', 64), 'recovery-user', CURRENT_TIMESTAMP);
INSERT INTO "FrozenReleaseItem" ("id", "organizationId", "releaseId", "sourcePlaylistItemId", "sourceAssetId", "assetName", "assetKind", "assetMimeType", "assetUrl", "assetStorageKey", "assetChecksumSha256", "assetSizeBytes", "assetCreatedAt", "position", "durationSeconds", "createdAt")
VALUES ('recovery-frozen-item', 'recovery-org', 'recovery-release', 'recovery-playlist-item', 'recovery-media', 'Recovery media', 'IMAGE', 'image/png', 'https://media.example.test/recovery/object.txt', 'organizations/recovery-org/assets/recovery-media/' || :'object_sha256', :'object_sha256', :'object_size'::bigint, CURRENT_TIMESTAMP, 0, 15, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "createdAt")
VALUES ('recovery-assignment', 'recovery-org', 'recovery-release', 'recovery-schedule', 'ASSIGNED', repeat('b', 64), 'recovery-user', 'Recovery schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('recovery-org', 'recovery-assignment', 'recovery-screen', 'recovery-screen', 'recovery-org');
INSERT INTO "AuditEvent" ("id", "organizationId", "actorUserId", "actorType", "action", "entityType", "entityId", "requestId", "metadata", "createdAt")
VALUES ('recovery-audit', 'recovery-org', 'recovery-user', 'user', 'release.published', 'published_release', 'recovery-release', 'recovery-drill', '{"fixture":true}', CURRENT_TIMESTAMP);
INSERT INTO "IdempotencyRecord" ("id", "organizationId", "operation", "keyHash", "actorUserId", "requestDigestSha256", "statusCode", "responseBody", "expiresAt", "createdAt")
VALUES ('recovery-idempotency', 'recovery-org', 'SCHEDULE_PUBLISH', repeat('d', 64), 'recovery-user', repeat('e', 64), 201, '{"published":true,"fixture":true}', CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP);
COMMIT;
SQL

dump_started_ns="$(date +%s%N)"
docker exec "$pg_container" pg_dump -U screengoblin -d screengoblin \
  --format=custom --no-owner --no-acl > "$work_dir/postgres.dump"
dump_duration_ms="$(elapsed_ms "$dump_started_ns")"
postgres_dump_bytes="$(stat --format=%s "$work_dir/postgres.dump")"
postgres_dump_sha256="$(sha256sum "$work_dir/postgres.dump" | cut -d ' ' -f 1)"
sha256sum "$work_dir/postgres.dump" > "$work_dir/postgres.dump.sha256"
sha256sum --check --strict "$work_dir/postgres.dump.sha256"

docker exec "$pg_container" createdb -U screengoblin screengoblin_restore_validation
restore_started_ns="$(date +%s%N)"
docker exec -i "$pg_container" pg_restore -U screengoblin \
  -d screengoblin_restore_validation --exit-on-error --no-owner --no-acl \
  < "$work_dir/postgres.dump"
postgres_restore_duration_ms="$(elapsed_ms "$restore_started_ns")"

restored_migration_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
)"
[[ "$restored_migration_count" == "$migration_directory_count" ]]
invalid_constraint_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated"
)"
[[ "$invalid_constraint_count" == 0 ]]
restored_audit_guard_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc "
SELECT
  (EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.\"AuditEvent\"'::regclass
      AND tgname = 'AuditEvent_reject_mutation'
      AND NOT tgisinternal
  ))::int
  + (EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'audit_event_metadata_shape_valid'
  ))::int;"
)"
[[ "$restored_audit_guard_count" == 2 ]]

if docker exec "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation -c \
  "UPDATE \"AuditEvent\" SET action = 'recovery.changed' WHERE id = 'recovery-audit'" \
  >/dev/null 2>&1; then
  echo "Restored AuditEvent mutation guard allowed an ordinary update" >&2
  exit 1
fi
restored_relation_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc "
SELECT count(*)
FROM \"Organization\" o
JOIN \"Membership\" m ON m.\"organizationId\" = o.id
JOIN \"User\" u ON u.id = m.\"userId\"
JOIN \"UserSession\" us ON us.\"organizationId\" = m.\"organizationId\" AND us.\"userId\" = m.\"userId\" AND us.\"authenticationEpoch\" = u.\"authenticationEpoch\" AND us.\"authorizationEpoch\" = m.\"authorizationEpoch\"
JOIN \"Location\" l ON l.\"organizationId\" = o.id
JOIN \"Screen\" s ON s.\"organizationId\" = o.id
JOIN \"PairingCode\" pc ON pc.\"organizationId\" = o.id AND pc.\"targetScreenId\" = s.id AND pc.\"authorizedByUserId\" = u.id AND pc.\"authorizedByMembershipId\" = m.id AND pc.\"authorizedByAuthenticationEpoch\" = u.\"authenticationEpoch\" AND pc.\"authorizedByAuthorizationEpoch\" = m.\"authorizationEpoch\"
JOIN \"PairingAttempt\" pa ON pa.\"organizationId\" = o.id AND pa.\"pairingCodeId\" = pc.id
JOIN \"ScheduleTarget\" st ON st.\"screenId\" = s.id AND st.\"organizationId\" = o.id
JOIN \"Schedule\" sc ON sc.id = st.\"scheduleId\" AND sc.\"organizationId\" = o.id
JOIN \"Playlist\" p ON p.id = sc.\"playlistId\" AND p.\"organizationId\" = o.id
JOIN \"PlaylistItem\" pi ON pi.\"playlistId\" = p.id AND pi.\"organizationId\" = o.id
JOIN \"MediaAsset\" ma ON ma.id = pi.\"assetId\" AND ma.\"organizationId\" = o.id
JOIN \"PublishedRelease\" pr ON pr.\"sourcePlaylistId\" = p.id AND pr.\"organizationId\" = o.id
JOIN \"FrozenReleaseItem\" fri ON fri.\"releaseId\" = pr.id AND fri.\"sourcePlaylistItemId\" = pi.id AND fri.\"sourceAssetId\" = ma.id AND fri.\"organizationId\" = o.id
JOIN \"ReleaseAssignment\" ra ON ra.\"releaseId\" = pr.id AND ra.\"scheduleId\" = sc.id AND ra.\"organizationId\" = o.id
JOIN \"ReleaseAssignmentTarget\" rat ON rat.\"assignmentId\" = ra.id AND rat.\"liveScreenId\" = s.id AND rat.\"liveScreenOrganizationId\" = o.id AND rat.\"organizationId\" = o.id
JOIN \"AuditEvent\" ae ON ae.\"organizationId\" = o.id AND ae.\"actorUserId\" = u.id AND ae.\"entityId\" = pr.id
JOIN \"IdempotencyRecord\" ir ON ir.\"organizationId\" = o.id AND ir.\"actorUserId\" = u.id
WHERE o.id = 'recovery-org'
  AND us.\"tokenHash\" = repeat('c', 64)
  AND s.\"locationId\" = l.id
  AND l.name = 'Recovery location'
  AND pc.\"codeHash\" = repeat('f', 64)
  AND pc.status = 'PENDING'
  AND pa.\"keyId\" = repeat('k', 43)
  AND ae.action = 'release.published'
  AND ir.operation = 'SCHEDULE_PUBLISH'
  AND ir.\"keyHash\" = repeat('d', 64);"
)"
[[ "$restored_relation_count" == 1 ]]
restored_object_metadata="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc "
SELECT concat_ws('|', ma.\"checksumSha256\", ma.\"sizeBytes\", ma.url, ma.\"storageKey\",
  fri.\"assetChecksumSha256\", fri.\"assetSizeBytes\", fri.\"assetUrl\", fri.\"assetStorageKey\")
FROM \"MediaAsset\" ma
JOIN \"FrozenReleaseItem\" fri
  ON fri.\"sourceAssetId\" = ma.id
 AND fri.\"organizationId\" = ma.\"organizationId\"
WHERE ma.id = 'recovery-media' AND ma.\"organizationId\" = 'recovery-org';"
)"
expected_object_metadata="$object_sha256|$object_size|https://media.example.test/recovery/object.txt|organizations/recovery-org/assets/recovery-media/$object_sha256|$object_sha256|$object_size|https://media.example.test/recovery/object.txt|organizations/recovery-org/assets/recovery-media/$object_sha256"
[[ "$restored_object_metadata" == "$expected_object_metadata" ]]

mkdir "$work_dir/object-backup"
docker run --detach --pull never --name "$minio_container" --network "$network" \
  --env MINIO_ROOT_USER=recoveryadmin \
  --env MINIO_ROOT_PASSWORD=recovery-test-password \
  "$minio_image" server /data >/dev/null
for attempt in {1..60}; do
  if docker run --rm --pull never --network "$network" --env HOME=/tmp "$mc_image" \
    alias set local "http://$minio_container:9000" recoveryadmin \
    recovery-test-password >/dev/null 2>&1; then break; fi
  [[ "$attempt" -lt 60 ]] || {
    echo "MinIO fixture did not become ready" >&2
    exit 1
  }
  sleep 1
done
object_restore_started_ns="$(date +%s%N)"
docker run --rm --pull never --network "$network" --volume "$work_dir:/work" \
  --user "$(id -u):$(id -g)" --env HOME=/tmp --entrypoint /bin/sh "$mc_image" -ceu "
  mc alias set local http://$minio_container:9000 recoveryadmin recovery-test-password >/dev/null
  mc mb local/recovery >/dev/null
  mc cp /work/object.txt local/recovery/object.txt >/dev/null
  mc mirror local/recovery /work/object-backup >/dev/null
  mc rb --force local/recovery >/dev/null
  mc mb local/recovery >/dev/null
  mc mirror /work/object-backup local/recovery >/dev/null
  mc cp local/recovery/object.txt /work/restored-object.txt >/dev/null
"
object_restore_duration_ms="$(elapsed_ms "$object_restore_started_ns")"
cmp "$work_dir/object.txt" "$work_dir/restored-object.txt"
[[ "$(sha256sum "$work_dir/restored-object.txt" | cut -d ' ' -f 1)" == "$object_sha256" ]]
[[ "$(stat --format=%s "$work_dir/restored-object.txt")" == "$object_size" ]]

rollback_started_ns="$(date +%s%N)"
docker build --pull --file "$ROLLBACK_DOCKERFILE" \
  --tag screengoblin/recovery-current:test .
docker tag screengoblin/recovery-current:test screengoblin/recovery-retained:test
retained_id="$(docker image inspect screengoblin/recovery-retained:test --format '{{.Id}}')"
docker build --pull=false --file - --tag screengoblin/recovery-current:test . <<EOF
FROM $alpine_image
RUN printf 'replacement' > /release-marker
EOF
docker tag screengoblin/recovery-retained:test screengoblin/recovery-current:test
[[ "$(docker image inspect screengoblin/recovery-current:test --format '{{.Id}}')" == "$retained_id" ]]
image_rollback_duration_ms="$(elapsed_ms "$rollback_started_ns")"
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$EVIDENCE_DIR/result.txt" <<EOF
Disposable CI Prisma migration chain: passed ($applied_migration_count migrations)
Disposable CI PostgreSQL application-graph dump/restore: passed
Restored PostgreSQL constraints and representative references: passed
Restored local AuditEvent bounds and ordinary-mutation trigger: passed
Referenced MinIO object metadata and restored bytes: passed
Retained Docker image rollback: passed
Source commit: $SOURCE_COMMIT
Retained image ID: $retained_id

These are elapsed measurements from a disposable hosted CI fixture. They are not
production RPO/RTO measurements and do not evidence off-host transfer, encryption,
retention, production data volume, regional loss, credential recovery, or operator response.
EOF

cat > "$EVIDENCE_DIR/measurements.json" <<EOF
{
  "evidenceType": "disposable-ci-recovery-drill",
  "sourceCommit": "$SOURCE_COMMIT",
  "startedAt": "$STARTED_AT",
  "completedAt": "$completed_at",
  "migrationDirectoryCount": $migration_directory_count,
  "appliedMigrationCount": $applied_migration_count,
  "restoredMigrationCount": $restored_migration_count,
  "invalidConstraintCount": $invalid_constraint_count,
  "restoredAuditGuardCount": $restored_audit_guard_count,
  "restoredRepresentativeGraphCount": $restored_relation_count,
  "postgresDumpBytes": $postgres_dump_bytes,
  "postgresDumpSha256": "$postgres_dump_sha256",
  "referencedObjectBytes": $object_size,
  "referencedObjectSha256": "$object_sha256",
  "migrationDurationMs": $migration_duration_ms,
  "postgresDumpDurationMs": $dump_duration_ms,
  "postgresRestoreDurationMs": $postgres_restore_duration_ms,
  "objectRestoreDurationMs": $object_restore_duration_ms,
  "imageRollbackDurationMs": $image_rollback_duration_ms,
  "productionRpoRtoEvidence": false
}
EOF
(
  cd "$EVIDENCE_DIR"
  sha256sum fixture-image-digests.txt measurements.json result.txt > SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)

echo "Migrated application-graph, referenced-object, and retained-image recovery checks passed"
