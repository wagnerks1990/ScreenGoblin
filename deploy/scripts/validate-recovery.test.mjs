import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptUrl = new URL("./validate-recovery.sh", import.meta.url);
const script = readFileSync(scriptUrl, "utf8");

test("recovery drill shell remains syntactically valid", () => {
  const result = spawnSync("bash", ["-n", scriptUrl.pathname], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("recovery drill migrates and restores representative application relations", () => {
  assert.match(script, /npm run prisma:migrate -w @screengoblin\/api/);
  assert.match(script, /"_prisma_migrations"/);
  for (const table of [
    "Organization",
    "Membership",
    "Location",
    "User",
    "Screen",
    "MediaAsset",
    "Playlist",
    "PlaylistItem",
    "Schedule",
    "ScheduleTarget",
    "PublishedRelease",
    "FrozenReleaseItem",
    "ReleaseAssignment",
    "ReleaseAssignmentTarget",
    "IdempotencyRecord",
    "AuditEvent",
  ]) {
    assert.match(script, new RegExp(`"${table}"`));
  }
  assert.match(script, /NOT convalidated/);
  assert.match(script, /AuditEvent_reject_mutation/);
  assert.match(script, /audit_event_metadata_shape_valid/);
  assert.match(script, /Restored AuditEvent mutation guard allowed/);
  assert.match(script, /restoredAuditGuardCount/);
  assert.match(script, /restored_relation_count/);
});

test("recovery evidence binds restored object metadata and rejects RPO claims", () => {
  assert.match(script, /assetChecksumSha256/);
  assert.match(script, /expected_object_metadata/);
  assert.match(script, /cmp "\$work_dir\/object\.txt"/);
  assert.match(script, /RECOVERY_SOURCE_COMMIT/);
  assert.match(script, /postgresDumpSha256/);
  assert.match(script, /productionRpoRtoEvidence": false/);
  assert.match(script, /not\nproduction RPO\/RTO measurements/);
});
