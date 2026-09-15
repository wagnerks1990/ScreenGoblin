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
  sh -c 'mv apps/api/prisma/migrations/20260912162000_targeted_initial_enrollment /tmp/targeted-initial-enrollment && mv apps/api/prisma/migrations/20260912163000_durable_membership_attribution /tmp/durable-membership-attribution && mv apps/api/prisma/migrations/20260915190000_release_approval_foundation /tmp/release-approval-foundation && npm run prisma:migrate -w @screengoblin/api'
docker exec -i "$pg_container" psql -U screengoblin -d screengoblin \
  -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('upgrade-enrollment-org', 'Upgrade enrollment fixture', 'upgrade-enrollment-fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
VALUES ('upgrade-attribution-user', 'upgrade-attribution@example.test', 'Upgrade attribution fixture', 'non-secret-fixture-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
VALUES ('upgrade-approver', 'upgrade-approver@example.test', 'Upgrade approver fixture', 'non-secret-fixture-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Membership" ("id", "organizationId", "userId", "role")
VALUES ('upgrade-attribution-membership', 'upgrade-enrollment-org', 'upgrade-attribution-user', 'OWNER');
INSERT INTO "Membership" ("id", "organizationId", "userId", "role")
VALUES ('upgrade-approver-membership', 'upgrade-enrollment-org', 'upgrade-approver', 'ADMIN');
INSERT INTO "PairingCode" ("id", "organizationId", "codeHash", "status", "expiresAt", "claimedAt", "createdAt")
VALUES
  ('upgrade-pending-grant', 'upgrade-enrollment-org', repeat('7', 64), 'PENDING', CURRENT_TIMESTAMP + INTERVAL '5 minutes', NULL, CURRENT_TIMESTAMP),
  ('upgrade-claimed-grant', 'upgrade-enrollment-org', repeat('8', 64), 'CLAIMED', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "PairingAttempt" ("id", "organizationId", "pairingCodeId", "keyId", "publicKeySpki", "algorithm", "securityLevel", "challengeHashSha256", "transcriptDigestSha256", "expiresAt", "createdAt")
VALUES (repeat('u', 43), 'upgrade-enrollment-org', 'upgrade-pending-grant', repeat('v', 43), decode(repeat('cd', 91), 'hex'), 'ES256', 'software', repeat('3', 64), repeat('4', 64), CURRENT_TIMESTAMP + INTERVAL '30 seconds', CURRENT_TIMESTAMP);
INSERT INTO "Location" ("id", "organizationId", "name", "createdAt", "updatedAt")
VALUES ('upgrade-location', 'upgrade-enrollment-org', 'Upgrade location', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Screen" ("id", "organizationId", "name", "location", "locationId", "status", "orientation", "resolution", "tags", "createdAt", "updatedAt")
VALUES
  ('upgrade-screen', 'upgrade-enrollment-org', 'Upgrade display', 'CI fixture', 'upgrade-location', 'OFFLINE', 'LANDSCAPE', '1920x1080', ARRAY['upgrade'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('upgrade-screen-2', 'upgrade-enrollment-org', 'Upgrade display 2', 'CI fixture', 'upgrade-location', 'OFFLINE', 'LANDSCAPE', '1920x1080', ARRAY['upgrade'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "MediaAsset" ("id", "organizationId", "storageKey", "name", "kind", "mimeType", "url", "checksumSha256", "sizeBytes", "durationSeconds", "createdAt", "updatedAt")
VALUES ('upgrade-media', 'upgrade-enrollment-org', 'organizations/upgrade-enrollment-org/assets/upgrade-media/fixture', 'Upgrade media', 'IMAGE', 'image/png', 'https://media.example.test/upgrade.png', repeat('a', 64), 128, 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Playlist" ("id", "organizationId", "name", "description", "createdAt", "updatedAt")
VALUES ('upgrade-playlist', 'upgrade-enrollment-org', 'Upgrade playlist', 'Legacy assignment fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "PlaylistItem" ("id", "organizationId", "playlistId", "assetId", "position", "durationSeconds")
VALUES ('upgrade-playlist-item', 'upgrade-enrollment-org', 'upgrade-playlist', 'upgrade-media', 0, 15);
INSERT INTO "Schedule" ("id", "organizationId", "playlistId", "name", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "createdAt", "updatedAt")
VALUES ('upgrade-schedule', 'upgrade-enrollment-org', 'upgrade-playlist', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "ScheduleTarget" ("organizationId", "scheduleId", "screenId")
VALUES
  ('upgrade-enrollment-org', 'upgrade-schedule', 'upgrade-screen'),
  ('upgrade-enrollment-org', 'upgrade-schedule', 'upgrade-screen-2');
INSERT INTO "PublishedRelease" ("id", "organizationId", "sourcePlaylistId", "sourcePlaylistName", "sourcePlaylistDescription", "sourcePlaylistUpdatedAt", "digestSha256", "createdById", "createdAt")
VALUES ('upgrade-release', 'upgrade-enrollment-org', 'upgrade-playlist', 'Upgrade playlist', 'Legacy assignment fixture', CURRENT_TIMESTAMP, repeat('b', 64), 'upgrade-attribution-user', CURRENT_TIMESTAMP);
INSERT INTO "FrozenReleaseItem" ("id", "organizationId", "releaseId", "sourcePlaylistItemId", "sourceAssetId", "assetName", "assetKind", "assetMimeType", "assetUrl", "assetStorageKey", "assetChecksumSha256", "assetSizeBytes", "assetCreatedAt", "position", "durationSeconds", "createdAt")
VALUES ('upgrade-frozen-item', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-playlist-item', 'upgrade-media', 'Upgrade media', 'IMAGE', 'image/png', 'https://media.example.test/upgrade.png', 'organizations/upgrade-enrollment-org/assets/upgrade-media/fixture', repeat('a', 64), 128, CURRENT_TIMESTAMP, 0, 15, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "createdAt")
VALUES ('upgrade-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('c', 64), 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES
  ('upgrade-enrollment-org', 'upgrade-assignment', 'upgrade-screen', 'upgrade-screen', 'upgrade-enrollment-org'),
  ('upgrade-enrollment-org', 'upgrade-assignment', 'upgrade-screen-2', 'upgrade-screen-2', 'upgrade-enrollment-org');
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
upgrade_attribution_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT count(*) FROM \"MembershipAttribution\" WHERE \"organizationId\" = 'upgrade-enrollment-org' AND \"userId\" = 'upgrade-attribution-user'"
)"
[[ "$upgrade_attribution_count" == 1 ]]
upgrade_legacy_assignment_result="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT state::text || '|' || \"approvalRequired\"::text FROM \"ReleaseAssignment\" WHERE id = 'upgrade-assignment'"
)"
[[ "$upgrade_legacy_assignment_result" == "ASSIGNED|false" ]]
release_provenance_trigger_metadata="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT trigger_row.tgenabled::text || '|' || trigger_row.tgdeferrable::text || '|' || trigger_row.tginitdeferred::text FROM pg_trigger trigger_row JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid WHERE relation_row.relname = 'ReleaseAssignment' AND trigger_row.tgname = 'ReleaseAssignment_require_candidate' AND NOT trigger_row.tgisinternal"
)"
[[ "$release_provenance_trigger_metadata" == "O|false|false" ]] || {
  echo "Release provenance trigger is missing, disabled, or deferred" >&2
  exit 1
}
release_withdrawal_trigger_metadata="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT trigger_row.tgenabled::text || '|' || trigger_row.tgdeferrable::text || '|' || trigger_row.tginitdeferred::text FROM pg_trigger trigger_row JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid WHERE relation_row.relname = 'ReleaseAssignment' AND trigger_row.tgname = 'ReleaseAssignment_withdrawal_targets_complete' AND NOT trigger_row.tgisinternal"
)"
[[ "$release_withdrawal_trigger_metadata" == "O|true|true" ]] || {
  echo "Release withdrawal target trigger is missing, disabled, or not initially deferred" >&2
  exit 1
}
release_provenance_fk_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='f' AND condeferrable AND condeferred AND array_length(conkey,1)=3 AND array_length(confkey,1)=3 AND ((conname='ReleaseCandidate_final_publication_fkey' AND conrelid='public.\"ReleaseCandidate\"'::regclass AND confrelid='public.\"ReleaseCandidatePublication\"'::regclass) OR (conname='ReleaseAssignment_final_publication_fkey' AND conrelid='public.\"ReleaseAssignment\"'::regclass AND confrelid='public.\"ReleaseCandidatePublication\"'::regclass))"
)"
[[ "$release_provenance_fk_count" == 2 ]] || {
  echo "Release reciprocal provenance foreign keys are missing or not initially deferred" >&2
  exit 1
}
release_assignment_provenance_check_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='c' AND convalidated AND conrelid='public.\"ReleaseAssignment\"'::regclass AND conname IN ('ReleaseAssignment_candidate_publication_state','ReleaseAssignment_expected_withdrawal_digest')"
)"
[[ "$release_assignment_provenance_check_count" == 2 ]] || {
  echo "Release assignment provenance checks are missing or unvalidated" >&2
  exit 1
}
release_publication_delete_fk_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='f' AND condeferrable AND condeferred AND confdeltype='a' AND conname IN ('ReleaseCandidatePublication_schedule_fkey','ReleaseCandidatePublication_assignment_fkey','ReleaseCandidatePublication_publisher_fkey')"
)"
[[ "$release_publication_delete_fk_count" == 3 ]] || {
  echo "Release publication delete dependencies are not safely deferred" >&2
  exit 1
}
tenant_cascade_deferred_fk_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confdeltype='a' AND condeferrable AND condeferred AND conname IN ('PlaylistItem_assetId_organizationId_fkey','PublishedRelease_sourcePlaylistId_organizationId_fkey','PublishedRelease_creator_attribution_fkey','FrozenReleaseItem_sourcePlaylistItemId_organizationId_fkey','FrozenReleaseItem_sourceAssetId_organizationId_fkey','ReleaseAssignment_releaseId_organizationId_fkey','ReleaseAssignment_scheduleId_organizationId_fkey','ReleaseAssignment_creator_attribution_fkey','ReleaseAssignment_previousAssignmentId_organizationId_fkey','ReleaseCandidate_release_fkey','ReleaseCandidate_author_fkey','ReleaseApproval_approver_fkey','ReleaseCandidatePublication_schedule_fkey','ReleaseCandidatePublication_assignment_fkey','ReleaseCandidatePublication_publisher_fkey','ReleaseCandidate_final_publication_fkey','ReleaseAssignment_final_publication_fkey','Screen_locationId_organizationId_fkey','PairingAttempt_boundCredentialId_organizationId_fkey')"
)"
[[ "$tenant_cascade_deferred_fk_count" == 19 ]] || {
  echo "Tenant cascade dependencies are not safely deferred" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "expectedWithdrawalDigestSha256", "createdAt")
VALUES ('orphan-approved-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('d', 64), 'upgrade-attribution-user', 'Orphan assignment', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, true, repeat('e', 64), CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Release provenance guard allowed an orphan approved assignment" >&2
  exit 1
fi
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('orphan-unapproved-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('f', 64), 'upgrade-attribution-user', 'Orphan unapproved assignment', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Release provenance guard allowed an ASSIGNED approvalRequired=false row" >&2
  exit 1
fi
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "candidatePublicationId", "expectedWithdrawalDigestSha256", "createdAt")
VALUES ('incomplete-provenance-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('0', 64), 'upgrade-attribution-user', 'Incomplete provenance assignment', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, true, 'missing-publication', repeat('1', 64), CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Deferred reciprocal provenance keys allowed an incomplete triangle" >&2
  exit 1
fi
incomplete_provenance_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'incomplete-provenance-assignment'"
)"
[[ "$incomplete_provenance_rollback_count" == 0 ]] || {
  echo "Failed incomplete provenance transaction left assignment rows behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseCandidate" ("id", "organizationId", "releaseId", "state", "digestSha256", "authorUserId", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "policyVersion", "expiresAt", "createdAt")
VALUES ('unfinalized-candidate', 'upgrade-enrollment-org', 'upgrade-release', 'DRAFT', repeat('3', 64), 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, 1, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP);
INSERT INTO "ReleaseCandidateTarget" ("organizationId", "candidateId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('upgrade-enrollment-org', 'unfinalized-candidate', 'upgrade-screen', 'upgrade-screen', 'upgrade-enrollment-org');
UPDATE "ReleaseCandidate" SET "state"='IN_REVIEW', "submittedAt"=CURRENT_TIMESTAMP WHERE "id"='unfinalized-candidate';
INSERT INTO "ReleaseApproval" ("id", "organizationId", "candidateId", "candidateDigestSha256", "approverUserId", "authenticationEpoch", "authorizationEpoch", "approvedAt")
VALUES ('unfinalized-approval', 'upgrade-enrollment-org', 'unfinalized-candidate', repeat('3', 64), 'upgrade-approver', 0, 0, CURRENT_TIMESTAMP);
UPDATE "ReleaseCandidate" SET "state"='APPROVED', "approvedAt"=CURRENT_TIMESTAMP WHERE "id"='unfinalized-candidate';
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "candidatePublicationId", "expectedWithdrawalDigestSha256", "createdAt")
VALUES ('unfinalized-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('4', 64), 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, true, 'unfinalized-publication', repeat('5', 64), CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('upgrade-enrollment-org', 'unfinalized-assignment', 'upgrade-screen', 'upgrade-screen', 'upgrade-enrollment-org');
INSERT INTO "ReleaseCandidatePublication" ("id", "organizationId", "candidateId", "scheduleId", "assignmentId", "publisherUserId", "publishedAt")
VALUES ('unfinalized-publication', 'upgrade-enrollment-org', 'unfinalized-candidate', 'upgrade-schedule', 'unfinalized-assignment', 'upgrade-attribution-user', CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Publication guard allowed evidence without candidate finalization" >&2
  exit 1
fi
unfinalized_triangle_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT (SELECT count(*) FROM \"ReleaseCandidate\" WHERE id = 'unfinalized-candidate') + (SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'unfinalized-assignment') + (SELECT count(*) FROM \"ReleaseCandidatePublication\" WHERE id = 'unfinalized-publication')"
)"
[[ "$unfinalized_triangle_rollback_count" == 0 ]] || {
  echo "Failed unfinalized publication transaction left triangle rows behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "previousAssignmentId", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('zero-target-withdrawal', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'WITHDRAWN', repeat('c', 64), 'upgrade-assignment', 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Deferred withdrawal guard allowed a zero-target withdrawal" >&2
  exit 1
fi
zero_target_withdrawal_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'zero-target-withdrawal'"
)"
[[ "$zero_target_withdrawal_rollback_count" == 0 ]] || {
  echo "Failed zero-target withdrawal transaction left assignment rows behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "previousAssignmentId", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('scalar-mismatch-withdrawal', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'WITHDRAWN', repeat('c', 64), 'upgrade-assignment', 'upgrade-attribution-user', 'Mismatched schedule name', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
SELECT "organizationId", 'scalar-mismatch-withdrawal', "screenId", "liveScreenId", "liveScreenOrganizationId"
FROM "ReleaseAssignmentTarget" WHERE "assignmentId"='upgrade-assignment';
COMMIT;
SQL
then
  echo "Deferred withdrawal guard allowed copied targets with mismatched scalars" >&2
  exit 1
fi
scalar_mismatch_withdrawal_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT (SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'scalar-mismatch-withdrawal') + (SELECT count(*) FROM \"ReleaseAssignmentTarget\" WHERE \"assignmentId\" = 'scalar-mismatch-withdrawal')"
)"
[[ "$scalar_mismatch_withdrawal_rollback_count" == 0 ]] || {
  echo "Failed scalar-mismatch withdrawal transaction left residue behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "previousAssignmentId", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('target-subset-withdrawal', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'WITHDRAWN', repeat('c', 64), 'upgrade-assignment', 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
SELECT "organizationId", 'target-subset-withdrawal', "screenId", "liveScreenId", "liveScreenOrganizationId"
FROM "ReleaseAssignmentTarget" WHERE "assignmentId"='upgrade-assignment' AND "screenId"='upgrade-screen';
COMMIT;
SQL
then
  echo "Deferred withdrawal guard allowed a strict target subset" >&2
  exit 1
fi
target_subset_withdrawal_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    "SELECT (SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'target-subset-withdrawal') + (SELECT count(*) FROM \"ReleaseAssignmentTarget\" WHERE \"assignmentId\" = 'target-subset-withdrawal')"
)"
[[ "$target_subset_withdrawal_rollback_count" == 0 ]] || {
  echo "Failed target-subset withdrawal transaction left residue behind" >&2
  exit 1
}
migration_duration_ms="$(elapsed_ms "$migration_started_ns")"
applied_migration_count="$(
  docker exec "$pg_container" psql -U screengoblin -d screengoblin -Atc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
)"
[[ "$applied_migration_count" == "$migration_directory_count" ]] || {
  echo "Applied migration count does not match checked-in migration directories" >&2
  exit 1
}

readonly recovery_publication_id="recovery-publication"
docker exec -i "$pg_container" psql -U screengoblin -d screengoblin \
  -v ON_ERROR_STOP=1 -v object_sha256="$object_sha256" \
  -v object_size="$object_size" -v publication_id="$recovery_publication_id" \
  >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('recovery-org', 'Recovery fixture', 'recovery-fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
VALUES ('recovery-user', 'recovery@example.test', 'Recovery operator', 'non-secret-fixture-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
VALUES ('recovery-approver', 'recovery-approver@example.test', 'Recovery approver', 'non-secret-fixture-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Membership" ("id", "organizationId", "userId", "role")
VALUES ('recovery-membership', 'recovery-org', 'recovery-user', 'OWNER');
INSERT INTO "Membership" ("id", "organizationId", "userId", "role")
VALUES ('recovery-approver-membership', 'recovery-org', 'recovery-approver', 'ADMIN');
INSERT INTO "UserSession" ("id", "organizationId", "userId", "tokenHash", "authenticationEpoch", "authorizationEpoch", "expiresAt", "createdAt")
VALUES ('recovery-session', 'recovery-org', 'recovery-user', repeat('c', 64), 0, 0, '2099-01-01T00:00:00Z', CURRENT_TIMESTAMP);
INSERT INTO "Location" ("id", "organizationId", "name", "createdAt", "updatedAt")
VALUES ('recovery-location', 'recovery-org', 'Recovery location', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Screen" ("id", "organizationId", "name", "location", "locationId", "status", "orientation", "resolution", "tags", "createdAt", "updatedAt")
VALUES ('recovery-screen', 'recovery-org', 'Recovery display', 'CI fixture', 'recovery-location', 'OFFLINE', 'LANDSCAPE', '1920x1080', ARRAY['recovery'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "DeviceKeyTombstone" ("keyId", "firstSeenAt")
VALUES (repeat('k', 43), CURRENT_TIMESTAMP);
INSERT INTO "DeviceCredential" ("id", "organizationId", "screenId", "liveScreenId", "liveScreenOrganizationId", "keyId", "publicKeySpki", "algorithm", "securityLevel", "createdAt")
VALUES ('recovery-credential', 'recovery-org', 'recovery-screen', 'recovery-screen', 'recovery-org', repeat('k', 43), decode(repeat('ab', 91), 'hex'), 'ES256', 'software', CURRENT_TIMESTAMP);
INSERT INTO "PairingCode" ("id", "organizationId", "purpose", "targetScreenId", "targetScreenReferenceId", "targetOrganizationId", "expectedGeneration", "authorizedByUserId", "authorizedByMembershipId", "authorizedByAuthenticationEpoch", "authorizedByAuthorizationEpoch", "requestReason", "codeHash", "status", "expiresAt", "createdAt")
VALUES ('recovery-enrollment-grant', 'recovery-org', 'NEW_SCREEN', 'recovery-screen', 'recovery-screen', 'recovery-org', 0, 'recovery-user', 'recovery-membership', 0, 0, 'Recovery-safe enrollment fixture', repeat('f', 64), 'PENDING', '2099-01-01T00:00:00Z', CURRENT_TIMESTAMP);
INSERT INTO "PairingAttempt" ("id", "organizationId", "pairingCodeId", "keyId", "publicKeySpki", "algorithm", "securityLevel", "challengeHashSha256", "transcriptDigestSha256", "expiresAt", "consumedAt", "boundCredentialId", "createdAt")
VALUES (repeat('a', 43), 'recovery-org', 'recovery-enrollment-grant', repeat('k', 43), decode(repeat('ab', 91), 'hex'), 'ES256', 'software', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '30 seconds', CURRENT_TIMESTAMP, 'recovery-credential', CURRENT_TIMESTAMP);
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
INSERT INTO "ReleaseCandidate" ("id", "organizationId", "releaseId", "state", "digestSha256", "authorUserId", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "policyVersion", "expiresAt", "createdAt")
VALUES ('recovery-candidate', 'recovery-org', 'recovery-release', 'DRAFT', repeat('9', 64), 'recovery-user', 'Recovery schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, 1, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP);
INSERT INTO "ReleaseCandidateTarget" ("organizationId", "candidateId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('recovery-org', 'recovery-candidate', 'recovery-screen', 'recovery-screen', 'recovery-org');
UPDATE "ReleaseCandidate"
SET "state" = 'IN_REVIEW', "submittedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'recovery-candidate';
INSERT INTO "ReleaseApproval" ("id", "organizationId", "candidateId", "candidateDigestSha256", "approverUserId", "authenticationEpoch", "authorizationEpoch", "approvedAt")
VALUES ('recovery-approval', 'recovery-org', 'recovery-candidate', repeat('9', 64), 'recovery-approver', 0, 0, CURRENT_TIMESTAMP);
UPDATE "ReleaseCandidate"
SET "state" = 'APPROVED', "approvedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'recovery-candidate';
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "candidatePublicationId", "expectedWithdrawalDigestSha256", "createdAt")
VALUES ('recovery-assignment', 'recovery-org', 'recovery-release', 'recovery-schedule', 'ASSIGNED', repeat('b', 64), 'recovery-user', 'Recovery schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, true, :'publication_id', repeat('c', 64), CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('recovery-org', 'recovery-assignment', 'recovery-screen', 'recovery-screen', 'recovery-org');
UPDATE "ReleaseCandidate"
SET "state" = 'PUBLISHED', "publishedAt" = CURRENT_TIMESTAMP, "publicationId" = :'publication_id'
WHERE "id" = 'recovery-candidate';
INSERT INTO "ReleaseCandidatePublication" ("id", "organizationId", "candidateId", "scheduleId", "assignmentId", "publisherUserId", "publishedAt")
VALUES (:'publication_id', 'recovery-org', 'recovery-candidate', 'recovery-schedule', 'recovery-assignment', 'recovery-user', CURRENT_TIMESTAMP);
INSERT INTO "AuditEvent" ("id", "organizationId", "actorUserId", "actorType", "action", "entityType", "entityId", "requestId", "metadata", "createdAt")
VALUES ('recovery-audit', 'recovery-org', 'recovery-user', 'user', 'release.published', 'published_release', 'recovery-release', 'recovery-drill', '{"fixture":true}', CURRENT_TIMESTAMP);
INSERT INTO "IdempotencyRecord" ("id", "organizationId", "operation", "keyHash", "actorUserId", "requestDigestSha256", "statusCode", "responseBody", "expiresAt", "createdAt")
VALUES ('recovery-idempotency', 'recovery-org', 'SCHEDULE_PUBLISH', repeat('d', 64), 'recovery-user', repeat('e', 64), 201, '{"published":true,"fixture":true}', CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP);
INSERT INTO "IdempotencyRecord" ("id", "organizationId", "operation", "keyHash", "actorUserId", "requestDigestSha256", "statusCode", "responseBody", "expiresAt", "createdAt")
VALUES ('recovery-candidate-idempotency', 'recovery-org', 'RELEASE_CANDIDATE_PUBLISH', repeat('6', 64), 'recovery-user', repeat('5', 64), 200, '{"candidateId":"recovery-candidate","state":"PUBLISHED","fixture":true}', CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP);
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
restored_attribution_guard_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc "
SELECT count(*)
FROM pg_trigger
WHERE tgname IN ('Membership_record_attribution', 'MembershipAttribution_reject_mutation')
  AND NOT tgisinternal;"
)"
[[ "$restored_attribution_guard_count" == 2 ]]
restored_release_guard_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc "
SELECT count(*)
FROM pg_trigger
WHERE tgname IN ('ReleaseCandidate_guard_history',
                 'ReleaseCandidateTarget_guard_history',
                 'ReleaseApproval_guard_history',
                 'ReleaseCandidatePublication_guard_history',
                 'ReleaseAssignment_require_candidate',
                 'ReleaseAssignmentTarget_guard_history',
                 'ReleaseAssignment_guard_approval_flag')
  AND NOT tgisinternal;"
)"
[[ "$restored_release_guard_count" == 7 ]]
restored_release_provenance_trigger_metadata="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT trigger_row.tgenabled::text || '|' || trigger_row.tgdeferrable::text || '|' || trigger_row.tginitdeferred::text FROM pg_trigger trigger_row JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid WHERE relation_row.relname = 'ReleaseAssignment' AND trigger_row.tgname = 'ReleaseAssignment_require_candidate' AND NOT trigger_row.tgisinternal"
)"
[[ "$restored_release_provenance_trigger_metadata" == "O|false|false" ]] || {
  echo "Restored release provenance trigger is missing, disabled, or deferred" >&2
  exit 1
}
restored_release_withdrawal_trigger_metadata="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT trigger_row.tgenabled::text || '|' || trigger_row.tgdeferrable::text || '|' || trigger_row.tginitdeferred::text FROM pg_trigger trigger_row JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid WHERE relation_row.relname = 'ReleaseAssignment' AND trigger_row.tgname = 'ReleaseAssignment_withdrawal_targets_complete' AND NOT trigger_row.tgisinternal"
)"
[[ "$restored_release_withdrawal_trigger_metadata" == "O|true|true" ]] || {
  echo "Restored release withdrawal target trigger is missing, disabled, or not initially deferred" >&2
  exit 1
}
restored_release_provenance_fk_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='f' AND condeferrable AND condeferred AND array_length(conkey,1)=3 AND array_length(confkey,1)=3 AND ((conname='ReleaseCandidate_final_publication_fkey' AND conrelid='public.\"ReleaseCandidate\"'::regclass AND confrelid='public.\"ReleaseCandidatePublication\"'::regclass) OR (conname='ReleaseAssignment_final_publication_fkey' AND conrelid='public.\"ReleaseAssignment\"'::regclass AND confrelid='public.\"ReleaseCandidatePublication\"'::regclass))"
)"
[[ "$restored_release_provenance_fk_count" == 2 ]] || {
  echo "Restored reciprocal provenance foreign keys are missing or not initially deferred" >&2
  exit 1
}
restored_release_assignment_provenance_check_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='c' AND convalidated AND conrelid='public.\"ReleaseAssignment\"'::regclass AND conname IN ('ReleaseAssignment_candidate_publication_state','ReleaseAssignment_expected_withdrawal_digest')"
)"
[[ "$restored_release_assignment_provenance_check_count" == 2 ]] || {
  echo "Restored release assignment provenance checks are missing or unvalidated" >&2
  exit 1
}
restored_release_publication_delete_fk_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='f' AND condeferrable AND condeferred AND confdeltype='a' AND conname IN ('ReleaseCandidatePublication_schedule_fkey','ReleaseCandidatePublication_assignment_fkey','ReleaseCandidatePublication_publisher_fkey')"
)"
[[ "$restored_release_publication_delete_fk_count" == 3 ]] || {
  echo "Restored release publication delete dependencies are not safely deferred" >&2
  exit 1
}
restored_tenant_cascade_deferred_fk_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confdeltype='a' AND condeferrable AND condeferred AND conname IN ('PlaylistItem_assetId_organizationId_fkey','PublishedRelease_sourcePlaylistId_organizationId_fkey','PublishedRelease_creator_attribution_fkey','FrozenReleaseItem_sourcePlaylistItemId_organizationId_fkey','FrozenReleaseItem_sourceAssetId_organizationId_fkey','ReleaseAssignment_releaseId_organizationId_fkey','ReleaseAssignment_scheduleId_organizationId_fkey','ReleaseAssignment_creator_attribution_fkey','ReleaseAssignment_previousAssignmentId_organizationId_fkey','ReleaseCandidate_release_fkey','ReleaseCandidate_author_fkey','ReleaseApproval_approver_fkey','ReleaseCandidatePublication_schedule_fkey','ReleaseCandidatePublication_assignment_fkey','ReleaseCandidatePublication_publisher_fkey','ReleaseCandidate_final_publication_fkey','ReleaseAssignment_final_publication_fkey','Screen_locationId_organizationId_fkey','PairingAttempt_boundCredentialId_organizationId_fkey')"
)"
[[ "$restored_tenant_cascade_deferred_fk_count" == 19 ]] || {
  echo "Restored tenant cascade dependencies are not safely deferred" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation >/dev/null 2>&1 <<'SQL'
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "expectedWithdrawalDigestSha256", "createdAt")
VALUES ('restored-orphan-approved-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('e', 64), 'upgrade-attribution-user', 'Restored orphan assignment', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, true, repeat('f', 64), CURRENT_TIMESTAMP);
SQL
then
  echo "Restored release provenance guard allowed an orphan approved assignment" >&2
  exit 1
fi
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('restored-orphan-unapproved-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('1', 64), 'upgrade-attribution-user', 'Restored orphan unapproved assignment', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Restored release provenance guard allowed an ASSIGNED approvalRequired=false row" >&2
  exit 1
fi
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "candidatePublicationId", "expectedWithdrawalDigestSha256", "createdAt")
VALUES ('restored-incomplete-provenance-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('2', 64), 'upgrade-attribution-user', 'Restored incomplete provenance assignment', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, true, 'restored-missing-publication', repeat('3', 64), CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Restored deferred reciprocal provenance keys allowed an incomplete triangle" >&2
  exit 1
fi
restored_incomplete_provenance_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'restored-incomplete-provenance-assignment'"
)"
[[ "$restored_incomplete_provenance_rollback_count" == 0 ]] || {
  echo "Failed restored incomplete provenance transaction left assignment rows behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseCandidate" ("id", "organizationId", "releaseId", "state", "digestSha256", "authorUserId", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "policyVersion", "expiresAt", "createdAt")
VALUES ('restored-unfinalized-candidate', 'upgrade-enrollment-org', 'upgrade-release', 'DRAFT', repeat('7', 64), 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, 1, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP);
INSERT INTO "ReleaseCandidateTarget" ("organizationId", "candidateId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('upgrade-enrollment-org', 'restored-unfinalized-candidate', 'upgrade-screen', 'upgrade-screen', 'upgrade-enrollment-org');
UPDATE "ReleaseCandidate" SET "state"='IN_REVIEW', "submittedAt"=CURRENT_TIMESTAMP WHERE "id"='restored-unfinalized-candidate';
INSERT INTO "ReleaseApproval" ("id", "organizationId", "candidateId", "candidateDigestSha256", "approverUserId", "authenticationEpoch", "authorizationEpoch", "approvedAt")
VALUES ('restored-unfinalized-approval', 'upgrade-enrollment-org', 'restored-unfinalized-candidate', repeat('7', 64), 'upgrade-approver', 0, 0, CURRENT_TIMESTAMP);
UPDATE "ReleaseCandidate" SET "state"='APPROVED', "approvedAt"=CURRENT_TIMESTAMP WHERE "id"='restored-unfinalized-candidate';
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "candidatePublicationId", "expectedWithdrawalDigestSha256", "createdAt")
VALUES ('restored-unfinalized-assignment', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'ASSIGNED', repeat('8', 64), 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, true, 'restored-unfinalized-publication', repeat('9', 64), CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
VALUES ('upgrade-enrollment-org', 'restored-unfinalized-assignment', 'upgrade-screen', 'upgrade-screen', 'upgrade-enrollment-org');
INSERT INTO "ReleaseCandidatePublication" ("id", "organizationId", "candidateId", "scheduleId", "assignmentId", "publisherUserId", "publishedAt")
VALUES ('restored-unfinalized-publication', 'upgrade-enrollment-org', 'restored-unfinalized-candidate', 'upgrade-schedule', 'restored-unfinalized-assignment', 'upgrade-attribution-user', CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Restored publication guard allowed evidence without candidate finalization" >&2
  exit 1
fi
restored_unfinalized_triangle_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT (SELECT count(*) FROM \"ReleaseCandidate\" WHERE id = 'restored-unfinalized-candidate') + (SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'restored-unfinalized-assignment') + (SELECT count(*) FROM \"ReleaseCandidatePublication\" WHERE id = 'restored-unfinalized-publication')"
)"
[[ "$restored_unfinalized_triangle_rollback_count" == 0 ]] || {
  echo "Failed restored unfinalized publication transaction left triangle rows behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "previousAssignmentId", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('restored-zero-target-withdrawal', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'WITHDRAWN', repeat('c', 64), 'upgrade-assignment', 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
COMMIT;
SQL
then
  echo "Restored deferred withdrawal guard allowed a zero-target withdrawal" >&2
  exit 1
fi
restored_zero_target_withdrawal_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'restored-zero-target-withdrawal'"
)"
[[ "$restored_zero_target_withdrawal_rollback_count" == 0 ]] || {
  echo "Failed restored zero-target withdrawal transaction left assignment rows behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "previousAssignmentId", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('restored-scalar-mismatch-withdrawal', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'WITHDRAWN', repeat('c', 64), 'upgrade-assignment', 'upgrade-attribution-user', 'Mismatched restored schedule name', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
SELECT "organizationId", 'restored-scalar-mismatch-withdrawal', "screenId", "liveScreenId", "liveScreenOrganizationId"
FROM "ReleaseAssignmentTarget" WHERE "assignmentId"='upgrade-assignment';
COMMIT;
SQL
then
  echo "Restored deferred withdrawal guard allowed copied targets with mismatched scalars" >&2
  exit 1
fi
restored_scalar_mismatch_withdrawal_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT (SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'restored-scalar-mismatch-withdrawal') + (SELECT count(*) FROM \"ReleaseAssignmentTarget\" WHERE \"assignmentId\" = 'restored-scalar-mismatch-withdrawal')"
)"
[[ "$restored_scalar_mismatch_withdrawal_rollback_count" == 0 ]] || {
  echo "Failed restored scalar-mismatch withdrawal transaction left residue behind" >&2
  exit 1
}
if docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO "ReleaseAssignment" ("id", "organizationId", "releaseId", "scheduleId", "state", "digestSha256", "previousAssignmentId", "createdById", "scheduleName", "priority", "startsAt", "endsAt", "timezone", "daysOfWeek", "enabled", "approvalRequired", "createdAt")
VALUES ('restored-target-subset-withdrawal', 'upgrade-enrollment-org', 'upgrade-release', 'upgrade-schedule', 'WITHDRAWN', repeat('c', 64), 'upgrade-assignment', 'upgrade-attribution-user', 'Upgrade schedule', 'NORMAL', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'UTC', ARRAY[1,2,3,4,5], true, false, CURRENT_TIMESTAMP);
INSERT INTO "ReleaseAssignmentTarget" ("organizationId", "assignmentId", "screenId", "liveScreenId", "liveScreenOrganizationId")
SELECT "organizationId", 'restored-target-subset-withdrawal', "screenId", "liveScreenId", "liveScreenOrganizationId"
FROM "ReleaseAssignmentTarget" WHERE "assignmentId"='upgrade-assignment' AND "screenId"='upgrade-screen';
COMMIT;
SQL
then
  echo "Restored deferred withdrawal guard allowed a strict target subset" >&2
  exit 1
fi
restored_target_subset_withdrawal_rollback_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc \
    "SELECT (SELECT count(*) FROM \"ReleaseAssignment\" WHERE id = 'restored-target-subset-withdrawal') + (SELECT count(*) FROM \"ReleaseAssignmentTarget\" WHERE \"assignmentId\" = 'restored-target-subset-withdrawal')"
)"
[[ "$restored_target_subset_withdrawal_rollback_count" == 0 ]] || {
  echo "Failed restored target-subset withdrawal transaction left residue behind" >&2
  exit 1
}

if docker exec "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation -c \
  "UPDATE \"AuditEvent\" SET action = 'recovery.changed' WHERE id = 'recovery-audit'" \
  >/dev/null 2>&1; then
  echo "Restored AuditEvent mutation guard allowed an ordinary update" >&2
  exit 1
fi
if docker exec "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation -c \
  "UPDATE \"ReleaseCandidate\" SET \"digestSha256\" = repeat('0', 64) WHERE id = 'recovery-candidate'" \
  >/dev/null 2>&1; then
  echo "Restored ReleaseCandidate mutation guard allowed snapshot drift" >&2
  exit 1
fi
restored_relation_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc "
SELECT count(*)
FROM \"Organization\" o
JOIN \"Membership\" m ON m.\"organizationId\" = o.id
JOIN \"MembershipAttribution\" mat ON mat.\"organizationId\" = m.\"organizationId\" AND mat.\"userId\" = m.\"userId\"
JOIN \"User\" u ON u.id = m.\"userId\"
JOIN \"UserSession\" us ON us.\"organizationId\" = m.\"organizationId\" AND us.\"userId\" = m.\"userId\" AND us.\"authenticationEpoch\" = u.\"authenticationEpoch\" AND us.\"authorizationEpoch\" = m.\"authorizationEpoch\"
JOIN \"Location\" l ON l.\"organizationId\" = o.id
JOIN \"Screen\" s ON s.\"organizationId\" = o.id
JOIN \"PairingCode\" pc ON pc.\"organizationId\" = o.id AND pc.\"targetScreenId\" = s.id AND pc.\"authorizedByUserId\" = u.id AND pc.\"authorizedByMembershipId\" = m.id AND pc.\"authorizedByAuthenticationEpoch\" = u.\"authenticationEpoch\" AND pc.\"authorizedByAuthorizationEpoch\" = m.\"authorizationEpoch\"
JOIN \"PairingAttempt\" pa ON pa.\"organizationId\" = o.id AND pa.\"pairingCodeId\" = pc.id
JOIN \"DeviceCredential\" dc ON dc.id = pa.\"boundCredentialId\" AND dc.\"organizationId\" = pa.\"organizationId\" AND dc.\"liveScreenId\" = s.id AND dc.\"liveScreenOrganizationId\" = o.id
JOIN \"ScheduleTarget\" st ON st.\"screenId\" = s.id AND st.\"organizationId\" = o.id
JOIN \"Schedule\" sc ON sc.id = st.\"scheduleId\" AND sc.\"organizationId\" = o.id
JOIN \"Playlist\" p ON p.id = sc.\"playlistId\" AND p.\"organizationId\" = o.id
JOIN \"PlaylistItem\" pi ON pi.\"playlistId\" = p.id AND pi.\"organizationId\" = o.id
JOIN \"MediaAsset\" ma ON ma.id = pi.\"assetId\" AND ma.\"organizationId\" = o.id
JOIN \"PublishedRelease\" pr ON pr.\"sourcePlaylistId\" = p.id AND pr.\"organizationId\" = o.id AND pr.\"createdById\" = mat.\"userId\"
JOIN \"FrozenReleaseItem\" fri ON fri.\"releaseId\" = pr.id AND fri.\"sourcePlaylistItemId\" = pi.id AND fri.\"sourceAssetId\" = ma.id AND fri.\"organizationId\" = o.id
JOIN \"ReleaseCandidate\" rc ON rc.\"releaseId\" = pr.id AND rc.\"organizationId\" = o.id AND rc.\"authorUserId\" = mat.\"userId\"
JOIN \"ReleaseCandidateTarget\" rct ON rct.\"candidateId\" = rc.id AND rct.\"screenId\" = s.id AND rct.\"liveScreenId\" = s.id AND rct.\"liveScreenOrganizationId\" = o.id AND rct.\"organizationId\" = o.id
JOIN \"ReleaseApproval\" rap ON rap.\"candidateId\" = rc.id AND rap.\"organizationId\" = o.id AND rap.\"candidateDigestSha256\" = rc.\"digestSha256\"
JOIN \"ReleaseAssignment\" ra ON ra.\"releaseId\" = pr.id AND ra.\"scheduleId\" = sc.id AND ra.\"organizationId\" = o.id AND ra.\"createdById\" = mat.\"userId\"
JOIN \"ReleaseAssignmentTarget\" rat ON rat.\"assignmentId\" = ra.id AND rat.\"liveScreenId\" = s.id AND rat.\"liveScreenOrganizationId\" = o.id AND rat.\"organizationId\" = o.id
JOIN \"ReleaseCandidatePublication\" rcp ON rcp.\"candidateId\" = rc.id AND rcp.\"scheduleId\" = sc.id AND rcp.\"assignmentId\" = ra.id AND rcp.\"organizationId\" = o.id
JOIN \"AuditEvent\" ae ON ae.\"organizationId\" = o.id AND ae.\"actorUserId\" = u.id AND ae.\"entityId\" = pr.id
JOIN \"IdempotencyRecord\" ir ON ir.\"organizationId\" = o.id AND ir.\"actorUserId\" = u.id
WHERE o.id = 'recovery-org'
  AND us.\"tokenHash\" = repeat('c', 64)
  AND s.\"locationId\" = l.id
  AND l.name = 'Recovery location'
  AND pc.\"codeHash\" = repeat('f', 64)
  AND pc.status = 'PENDING'
  AND pa.\"keyId\" = repeat('k', 43)
  AND rc.state = 'PUBLISHED'
  AND rc.\"publicationId\" = rcp.id
  AND rap.\"approverUserId\" = 'recovery-approver'
  AND rcp.\"publisherUserId\" = 'recovery-user'
  AND ra.\"approvalRequired\"
  AND ra.\"candidatePublicationId\" = rcp.id
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
docker exec "$pg_container" psql -v ON_ERROR_STOP=1 -U screengoblin \
  -d screengoblin_restore_validation -c \
  "DELETE FROM \"Organization\" WHERE id = 'recovery-org'" >/dev/null
restored_tenant_residue_count="$(
  docker exec "$pg_container" psql -U screengoblin \
    -d screengoblin_restore_validation -Atc "
SELECT (SELECT count(*) FROM \"ReleaseCandidate\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"ReleaseApproval\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"ReleaseCandidatePublication\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"ReleaseAssignment\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"PublishedRelease\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"FrozenReleaseItem\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"ReleaseCandidateTarget\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"ReleaseAssignmentTarget\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"Schedule\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"ScheduleTarget\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"Playlist\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"PlaylistItem\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"MediaAsset\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"MembershipAttribution\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"Screen\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"PairingAttempt\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"DeviceCredential\" WHERE \"organizationId\"='recovery-org')
     + (SELECT count(*) FROM \"Organization\" WHERE id='recovery-org');"
)"
[[ "$restored_tenant_residue_count" == 0 ]]

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
Restored durable membership attribution and mutation guards: passed
Restored release-candidate immutability and provenance guards: passed
Restored tenant cascade across release-candidate history: passed
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
  "restoredAttributionGuardCount": $restored_attribution_guard_count,
  "restoredReleaseGuardCount": $restored_release_guard_count,
  "restoredTenantResidueCount": $restored_tenant_residue_count,
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
