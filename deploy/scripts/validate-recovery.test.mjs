import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptUrl = new URL("./validate-recovery.sh", import.meta.url);
const script = readFileSync(scriptUrl, "utf8");
const prismaStore = readFileSync(
  new URL("../../apps/api/src/store/prisma.ts", import.meta.url),
  "utf8",
);
const releaseApprovalMigration = readFileSync(
  new URL(
    "../../apps/api/prisma/migrations/20260915190000_release_approval_foundation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("recovery drill shell remains syntactically valid", () => {
  const result = spawnSync("bash", ["-n", scriptUrl.pathname], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("recovery drill migrates and restores representative application relations", () => {
  assert.match(script, /npm run prisma:migrate -w @screengoblin\/api/);
  assert.match(
    script,
    /mv apps\/api\/prisma\/migrations\/20260915210000_scoped_authorization_foundation \/tmp\/scoped-authorization-foundation/,
  );
  assert.match(
    script,
    /mv apps\/api\/prisma\/migrations\/20260915230000_compatibility_grant_backfill \/tmp\/compatibility-grant-backfill/,
  );
  assert.match(script, /"_prisma_migrations"/);
  for (const table of [
    "Organization",
    "Membership",
    "Location",
    "User",
    "Screen",
    "ScreenGroup",
    "ScreenGroupMember",
    "AccessGrant",
    "PairingCode",
    "PairingAttempt",
    "MediaAsset",
    "Playlist",
    "PlaylistItem",
    "Schedule",
    "ScheduleTarget",
    "PublishedRelease",
    "FrozenReleaseItem",
    "ReleaseCandidate",
    "ReleaseCandidateTarget",
    "ReleaseApproval",
    "ReleaseCandidatePublication",
    "ReleaseAssignment",
    "ReleaseAssignmentTarget",
    "IdempotencyRecord",
    "AuditEvent",
  ]) {
    assert.match(script, new RegExp(`"${table}"`));
  }
  assert.match(script, /MembershipAttribution/);
  assert.match(script, /NOT convalidated/);
  assert.match(script, /AuditEvent_reject_mutation/);
  assert.match(script, /audit_event_metadata_shape_valid/);
  assert.match(script, /Membership_record_attribution/);
  assert.match(script, /MembershipAttribution_reject_mutation/);
  assert.match(script, /ReleaseAssignment_require_candidate/);
  assert.match(script, /restored_release_guard_count/);
  assert.match(script, /restoredReleaseGuardCount/);
  assert.match(script, /orphan approved assignment/);
  assert.match(script, /upgrade_legacy_assignment_result/);
  assert.match(
    script,
    /ReleaseCandidate mutation guard allowed snapshot drift/,
  );
  assert.match(script, /restored_tenant_residue_count/);
  assert.match(script, /authorizationMode\\\" = 'LEGACY'/);
  assert.match(script, /recovery-access-grant/);
  assert.match(script, /rc\.state = 'PUBLISHED'/);
  assert.match(script, /rap\.\\\"approverUserId\\\" = 'recovery-approver'/);
  assert.match(script, /rcp\.\\\"publisherUserId\\\" = 'recovery-user'/);
  assert.match(script, /ra\.\\\"approvalRequired\\\"/);
  assert.match(script, /upgrade_attribution_count/);
  assert.match(script, /upgrade_compatibility_grant_result/);
  assert.match(script, /upgrade_compatibility_publish_grant_id/);
  assert.match(script, /upgrade_authorization_epoch_result/);
  assert.match(script, /seed_fingerprint_before/);
  assert.match(script, /seed_fingerprint_after/);
  assert.match(script, /npm run prisma:seed -w @screengoblin\/api/);
  assert.match(script, /Restored AuditEvent mutation guard allowed/);
  assert.match(script, /restoredAuditGuardCount/);
  assert.match(script, /restored_relation_count/);
  assert.match(script, /authorizedByMembershipId/);
  assert.match(script, /authorizedByAuthenticationEpoch/);
  assert.match(script, /authorizedByAuthorizationEpoch/);
  assert.match(script, /pc\..*codeHash.*repeat\('f', 64\)/);
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

test("candidate GC waits through replay retention and compacts approval responses", () => {
  assert.match(
    prismaStore,
    /expiresAt:\s*\{\s*lte:\s*new Date\(\s*clock\.databaseNow\.getTime\(\)\s*-\s*RELEASE_CANDIDATE_RESPONSE_RETENTION_MS/,
  );
  assert.match(
    prismaStore,
    /'RELEASE_CANDIDATE_CREATE','RELEASE_CANDIDATE_SUBMIT','RELEASE_CANDIDATE_APPROVE'/,
  );
});

test("release assignment provenance uses immediate guards and reciprocal deferred keys", () => {
  const psqlHeredocCommands =
    script.match(/^(?:if )?docker exec(?:(?:[^\n]*\\\n))*[^\n]*<<'?SQL'?$/gm) ??
    [];
  assert.equal(psqlHeredocCommands.length, 16);
  for (const command of psqlHeredocCommands) {
    assert.match(command, /^(?:if )?docker exec -i "\$pg_container" psql/);
  }
  assert.doesNotMatch(releaseApprovalMigration, /PENDING_APPROVAL/);
  assert.doesNotMatch(script, /PENDING_APPROVAL/);
  assert.match(
    releaseApprovalMigration,
    /CREATE TRIGGER "ReleaseAssignment_require_candidate"\s+BEFORE INSERT OR UPDATE/,
  );
  assert.doesNotMatch(
    releaseApprovalMigration,
    /CREATE CONSTRAINT TRIGGER "ReleaseAssignment_require_candidate"/,
  );
  assert.match(
    releaseApprovalMigration,
    /NEW\."state"='ASSIGNED'[\s\S]*NOT NEW\."approvalRequired"[\s\S]*NEW\."candidatePublicationId" IS NULL[\s\S]*NEW\."expectedWithdrawalDigestSha256" IS NULL/,
  );
  assert.doesNotMatch(
    releaseApprovalMigration,
    /assignment_record\."createdAt"\s*<>\s*CURRENT_TIMESTAMP/,
  );
  assert.match(
    releaseApprovalMigration,
    /assignment_record\."state"='ASSIGNED'[\s\S]*NOT EXISTS \([\s\S]*FROM public\."ReleaseCandidatePublication"/,
  );
  assert.match(
    releaseApprovalMigration,
    /assignment_record\."state"='WITHDRAWN'[\s\S]*previous_target\."screenId"=NEW\."screenId"[\s\S]*previous_target\."liveScreenId" IS NOT DISTINCT FROM NEW\."liveScreenId"[\s\S]*previous_target\."liveScreenOrganizationId" IS NOT DISTINCT FROM NEW\."liveScreenOrganizationId"/,
  );
  assert.match(
    releaseApprovalMigration,
    /CREATE CONSTRAINT TRIGGER "ReleaseAssignment_withdrawal_targets_complete"[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    releaseApprovalMigration,
    /ReleaseAssignment_expected_withdrawal_digest[\s\S]*expectedWithdrawalDigestSha256[\s\S]*\^\[0-9a-f\]\{64\}\$/,
  );
  assert.match(
    releaseApprovalMigration,
    /previous_record\."approvalRequired"[\s\S]*assignment_record\."digestSha256" IS DISTINCT FROM previous_record\."expectedWithdrawalDigestSha256"/,
  );
  assert.match(
    prismaStore,
    /const expectedWithdrawalDigestSha256 = assignmentSnapshotDigest\([\s\S]*previousAssignmentId: assignmentId[\s\S]*expectedWithdrawalDigestSha256/,
  );
  assert.match(
    releaseApprovalMigration,
    /NOT EXISTS \([\s\S]*FROM public\."ReleaseCandidateTarget"[\s\S]*"liveScreenId" IS NULL[\s\S]*EXCEPT SELECT "screenId","liveScreenId","liveScreenOrganizationId" FROM public\."ReleaseAssignmentTarget"[\s\S]*EXCEPT SELECT "screenId" FROM public\."ScheduleTarget"/,
  );
  for (const constraint of [
    "ReleaseCandidate_final_publication_fkey",
    "ReleaseAssignment_final_publication_fkey",
  ])
    assert.match(
      releaseApprovalMigration,
      new RegExp(`${constraint}[^;]+DEFERRABLE INITIALLY DEFERRED`, "s"),
    );
  for (const constraint of [
    "PlaylistItem_assetId_organizationId_fkey",
    "PublishedRelease_sourcePlaylistId_organizationId_fkey",
    "PublishedRelease_creator_attribution_fkey",
    "FrozenReleaseItem_sourcePlaylistItemId_organizationId_fkey",
    "FrozenReleaseItem_sourceAssetId_organizationId_fkey",
    "ReleaseAssignment_releaseId_organizationId_fkey",
    "ReleaseAssignment_scheduleId_organizationId_fkey",
    "ReleaseAssignment_creator_attribution_fkey",
    "ReleaseAssignment_previousAssignmentId_organizationId_fkey",
    "ReleaseCandidate_release_fkey",
    "ReleaseCandidate_author_fkey",
    "ReleaseApproval_approver_fkey",
    "Screen_locationId_organizationId_fkey",
    "PairingAttempt_boundCredentialId_organizationId_fkey",
  ])
    assert.match(
      releaseApprovalMigration,
      new RegExp(
        `${constraint}[^;]+ON DELETE NO ACTION[^;]+DEFERRABLE INITIALLY DEFERRED`,
        "s",
      ),
    );
  for (const constraint of [
    "ReleaseCandidatePublication_schedule_fkey",
    "ReleaseCandidatePublication_assignment_fkey",
    "ReleaseCandidatePublication_publisher_fkey",
  ])
    assert.match(
      releaseApprovalMigration,
      new RegExp(
        `${constraint}[^;]+ON DELETE NO ACTION[^;]+DEFERRABLE INITIALLY DEFERRED`,
        "s",
      ),
    );
  assert.match(script, /O\|false\|false/);
  assert.match(script, /release_provenance_fk_count/);
  assert.match(script, /restored_release_provenance_fk_count/);
  assert.match(script, /release_publication_delete_fk_count/);
  assert.match(script, /restored_release_publication_delete_fk_count/);
  assert.match(script, /tenant_cascade_deferred_fk_count/);
  assert.match(script, /restored_tenant_cascade_deferred_fk_count/);
  assert.match(script, /confdeltype='a'/);
  assert.match(script, /condeferrable AND condeferred/);
  assert.match(script, /orphan-approved-assignment/);
  assert.match(script, /orphan-unapproved-assignment/);
  assert.match(script, /incomplete-provenance-assignment/);
  assert.match(script, /restored_release_provenance_trigger_metadata/);
  assert.match(script, /release_withdrawal_trigger_metadata/);
  assert.match(script, /restored_release_withdrawal_trigger_metadata/);
  assert.match(script, /release_assignment_provenance_check_count/);
  assert.match(script, /restored_release_assignment_provenance_check_count/);
  assert.equal(
    script.match(
      /ReleaseAssignment_candidate_publication_state','ReleaseAssignment_expected_withdrawal_digest/g,
    )?.length,
    2,
  );
  assert.match(script, /ReleaseAssignment_withdrawal_targets_complete/);
  assert.match(script, /O\|true\|true/);
  assert.equal(
    script.match(/trigger_row\.tgenabled::text \|\| '\|'/g)?.length,
    4,
  );
  assert.doesNotMatch(script, /trigger_row\.tgenabled \|\| '\|'/);
  assert.match(script, /restored-orphan-approved-assignment/);
  assert.match(script, /restored-orphan-unapproved-assignment/);
  assert.match(script, /restored-incomplete-provenance-assignment/);
  assert.match(script, /zero-target-withdrawal/);
  assert.match(script, /restored-zero-target-withdrawal/);
  assert.match(script, /scalar-mismatch-withdrawal/);
  assert.match(script, /restored-scalar-mismatch-withdrawal/);
  assert.match(script, /target-subset-withdrawal/);
  assert.match(script, /restored-target-subset-withdrawal/);
  assert.match(
    script,
    /'zero-target-withdrawal'[^;]+repeat\('c', 64\)[^;]+'upgrade-assignment'[^;]+'Upgrade schedule'[^;]+ARRAY\[1,2,3,4,5\][^;]+true, false/,
  );
  assert.match(
    script,
    /'restored-zero-target-withdrawal'[^;]+repeat\('c', 64\)[^;]+'upgrade-assignment'[^;]+'Upgrade schedule'[^;]+ARRAY\[1,2,3,4,5\][^;]+true, false/,
  );
  assert.match(
    script,
    /'upgrade-assignment', 'upgrade-screen-2', 'upgrade-screen-2', 'upgrade-enrollment-org'/,
  );
  assert.match(script, /incomplete_provenance_rollback_count/);
  assert.match(script, /unfinalized_triangle_rollback_count/);
  assert.match(script, /zero_target_withdrawal_rollback_count/);
  assert.match(script, /scalar_mismatch_withdrawal_rollback_count/);
  assert.match(script, /target_subset_withdrawal_rollback_count/);
  assert.match(script, /restored_incomplete_provenance_rollback_count/);
  assert.match(script, /restored_unfinalized_triangle_rollback_count/);
  assert.match(script, /restored_zero_target_withdrawal_rollback_count/);
  assert.match(script, /restored_scalar_mismatch_withdrawal_rollback_count/);
  assert.match(script, /restored_target_subset_withdrawal_rollback_count/);
  assert.match(
    script,
    /"approvalRequired", "expectedWithdrawalDigestSha256"[^;]+orphan-approved-assignment/,
  );
  assert.match(
    script,
    /"approvalRequired", "expectedWithdrawalDigestSha256"[^;]+restored-orphan-approved-assignment/,
  );
  assert.match(
    script,
    /Restored release provenance guard allowed an orphan approved assignment/,
  );
  assert.match(
    script,
    /Deferred reciprocal provenance keys allowed an incomplete triangle/,
  );
  assert.match(
    script,
    /Restored deferred reciprocal provenance keys allowed an incomplete triangle/,
  );
  assert.match(
    script,
    /Publication guard allowed evidence without candidate finalization/,
  );
  assert.match(
    script,
    /Restored publication guard allowed evidence without candidate finalization/,
  );
  assert.match(script, /unfinalized-publication/);
  assert.match(script, /restored-unfinalized-publication/);
  assert.match(script, /readonly recovery_publication_id/);
  assert.match(
    script,
    /"approvalRequired", "candidatePublicationId"[\s\S]*'ASSIGNED'[\s\S]*true, :'publication_id'/,
  );
  assert.match(
    script,
    /"state" = 'PUBLISHED', "publishedAt" = CURRENT_TIMESTAMP, "publicationId" = :'publication_id'/,
  );
  const validCandidateFinalization = script.indexOf(
    'SET "state" = \'PUBLISHED\', "publishedAt" = CURRENT_TIMESTAMP, "publicationId" = :\'publication_id\'',
  );
  const validPublicationInsert = script.indexOf(
    "VALUES (:'publication_id', 'recovery-org'",
  );
  assert.ok(validCandidateFinalization > 0);
  assert.ok(validPublicationInsert > validCandidateFinalization);
});
