import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../apps/api/prisma/migrations/20260912163000_durable_membership_attribution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../../apps/api/prisma/schema.prisma", import.meta.url),
  "utf8",
);

test("membership attribution migration is atomic and backfills before repointing history", () => {
  assert.match(migration, /^--[\s\S]*\nBEGIN;[\s\S]*COMMIT;\s*$/);
  const backfill = migration.indexOf('INSERT INTO "MembershipAttribution"');
  const publishedForeignKey = migration.indexOf(
    "PublishedRelease_creator_attribution_fkey",
  );
  const assignmentForeignKey = migration.indexOf(
    "ReleaseAssignment_creator_attribution_fkey",
  );
  assert.ok(backfill >= 0);
  assert.ok(publishedForeignKey > backfill);
  assert.ok(assignmentForeignKey > backfill);
  assert.match(
    migration,
    /SELECT "organizationId", "userId"\s+FROM "Membership"/,
  );
  assert.match(
    migration,
    /LOCK TABLE "Membership" IN SHARE ROW EXCLUSIVE MODE;[\s\S]*INSERT INTO "MembershipAttribution"[\s\S]*AFTER INSERT OR UPDATE OF "organizationId", "userId" ON "Membership"/,
  );
  assert.match(
    migration,
    /AFTER INSERT OR UPDATE OF "organizationId", "userId" ON "Membership"/,
  );
  assert.match(
    migration,
    /ON CONFLICT \("organizationId", "userId"\) DO NOTHING/,
  );
});

test("release attribution remains tenant-scoped and tombstones reject ordinary mutation", () => {
  for (const constraint of [
    "PublishedRelease_creator_attribution_fkey",
    "ReleaseAssignment_creator_attribution_fkey",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `${constraint}[\\s\\S]*FOREIGN KEY \\(\"organizationId\", \"createdById\"\\)[\\s\\S]*REFERENCES \"MembershipAttribution\"\\(\"organizationId\", \"userId\"\\)[\\s\\S]*ON DELETE RESTRICT`,
      ),
    );
  }
  assert.match(migration, /MembershipAttribution_reject_mutation/);
  assert.match(
    migration,
    /TG_OP = 'INSERT'[\s\S]*FROM public\."Membership"[\s\S]*"organizationId" = NEW\."organizationId"[\s\S]*"userId" = NEW\."userId"[\s\S]*ERRCODE = '23503'/,
  );
  assert.match(
    migration,
    /BEFORE INSERT OR UPDATE OR DELETE ON "MembershipAttribution"/,
  );
  assert.match(migration, /MembershipAttribution rows cannot be updated/);
  assert.match(
    migration,
    /MembershipAttribution rows cannot be deleted directly/,
  );
  assert.match(
    migration,
    /REFERENCES "Organization"\("id"\)\s+ON DELETE CASCADE/,
  );
  assert.match(schema, /model MembershipAttribution/);
  assert.doesNotMatch(
    schema,
    /createdBy\s+Membership\s+@relation\("(?:PublishedRelease|ReleaseAssignment)CreatorMembership"/,
  );
});

test("publication revalidation locks the live membership and user", () => {
  const prismaStore = readFileSync(
    new URL("../../apps/api/src/store/prisma.ts", import.meta.url),
    "utf8",
  );
  const start = prismaStore.indexOf("async publishReleaseCandidateAndAudit(");
  const end = prismaStore.indexOf("async withdrawScheduleAndAudit(", start);
  assert.ok(start >= 0 && end > start);
  const publication = prismaStore.slice(start, end);
  assert.match(
    publication,
    /FROM "Membership" AS m[\s\S]*INNER JOIN "User" AS u[\s\S]*FOR UPDATE OF m, u/,
  );
});
