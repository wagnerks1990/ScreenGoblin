import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../apps/api/prisma/migrations/20260912162000_targeted_initial_enrollment/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const devices = readFileSync(
  new URL("../../apps/api/src/routes/devices.ts", import.meta.url),
  "utf8",
);
const prismaStore = readFileSync(
  new URL("../../apps/api/src/store/prisma.ts", import.meta.url),
  "utf8",
);
const recovery = readFileSync(
  new URL("./validate-recovery.sh", import.meta.url),
  "utf8",
);
const composeRuntime = readFileSync(
  new URL("./validate-compose-runtime.sh", import.meta.url),
  "utf8",
);

test("targeted enrollment migration fails closed for legacy pending grants", () => {
  assert.match(migration, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(
    migration,
    /UPDATE "PairingAttempt"[\s\S]*pairing_grant\."status" = 'PENDING'[\s\S]*"cancelledAt" IS NULL/,
  );
  assert.match(
    migration,
    /UPDATE "PairingCode"[\s\S]*WHERE "status" = 'PENDING'/,
  );
  assert.match(migration, /"targetOrganizationId" = "organizationId"/);
  assert.match(
    migration,
    /"operation"::text IN \('SCHEDULE_PUBLISH', 'SCREEN_ENROLLMENT_CREATE'\) AND "statusCode" = 201\)[\s\S]*"operation"::text = 'SCREEN_ENROLLMENT_ACTIVATE' AND "statusCode" = 200/,
  );
  assert.doesNotMatch(
    migration,
    /"operation"\s*(?:=|IN)\s*\(?[^\n]*SCREEN_ENROLLMENT/,
  );
  assert.match(migration, /"targetScreenReferenceId" = "targetScreenId"/);
  assert.match(
    migration,
    /"purpose" = 'REENROLL' AND "expectedGeneration" > 0/,
  );
  for (const field of [
    "targetOrganizationId",
    "targetScreenReferenceId",
    "expectedGeneration",
  ]) {
    assert.match(migration, new RegExp(`"${field}" IS NOT NULL`));
  }
  assert.match(
    migration,
    /"purpose" = 'NEW_SCREEN'[\s\S]*"authorizedByMembershipId" IS NOT NULL[\s\S]*"authorizedByAuthenticationEpoch" IS NOT NULL[\s\S]*"authorizedByAuthorizationEpoch" IS NOT NULL/,
  );
  for (const field of [
    "authorizedByUserId",
    "authorizedByMembershipId",
    "authorizedByAuthenticationEpoch",
    "authorizedByAuthorizationEpoch",
  ]) {
    assert.match(migration, new RegExp(`"${field}" IS NOT NULL`));
  }
  assert.doesNotMatch(
    migration,
    /UPDATE "PairingCode"[\s\S]*SET "authorizedBy(?:MembershipId|AuthenticationEpoch|AuthorizationEpoch)"/,
  );
});

test("recovery uses a constraint-valid canonical pairing attempt", () => {
  assert.match(
    recovery,
    /VALUES \(repeat\('a', 43\)[\s\S]*CURRENT_TIMESTAMP \+ INTERVAL '30 seconds'/,
  );
  assert.doesNotMatch(recovery, /'recovery-enrollment-attempt'/);
});

test("recovery upgrades legacy pending authority and preserves claimed history", () => {
  assert.match(
    recovery,
    /mv apps\/api\/prisma\/migrations\/20260912162000_targeted_initial_enrollment[\s\S]*upgrade-pending-grant[\s\S]*upgrade-claimed-grant/,
  );
  assert.match(
    recovery,
    /upgrade_authority_result[\s\S]*REVOKED\|true\|CLAIMED/,
  );
});

test("targeted enrollment SQL never uses a reserved authorization word as an alias", () => {
  const reservedAlias =
    /(?:FROM|JOIN|UPDATE)\s+"[^"]+"\s+(?:grant|user|group|role)\b/i;
  assert.doesNotMatch(migration, reservedAlias);
  assert.doesNotMatch(prismaStore, reservedAlias);
  assert.doesNotMatch(composeRuntime, reservedAlias);
  assert.match(
    composeRuntime,
    /--set enrollment_secret=[\s\S]*--set enrollment_screen=[\s\S]*--file=- <<'SQL'[\s\S]*FROM "PairingCode" pairing_grant[\s\S]*pairing_grant\."authorizedByMembershipId"[\s\S]*:'enrollment_secret'[\s\S]*^SQL$/m,
  );
  assert.doesNotMatch(
    composeRuntime,
    /--set enrollment_secret=[^\n]*[\s\S]{0,200}-c "[\s\S]*:'enrollment_secret'/,
  );
});

test("proof-v1 cannot mint an unbound production pairing authority", () => {
  assert.match(
    devices,
    /deviceAuthMode === "proof-v1"[\s\S]*UNTARGETED_ENROLLMENT_REMOVED/,
  );
});
