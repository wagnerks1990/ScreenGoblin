import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../apps/api/prisma/migrations/20260915210000_scoped_authorization_foundation/migration.sql",
  import.meta.url,
);

test("scoped authorization foundation is additive and latched to legacy", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /"authorizationMode"\s*=\s*'LEGACY'::"AuthorizationMode"/,
  );
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"AccessGrant"/i);
  assert.doesNotMatch(migration, /'emergency\.[^']*'/);
  assert.doesNotMatch(migration, /'authorization\.manage'/);
  assert.match(migration, /CREATE TRIGGER "Membership_revoke_access_grants"/);
  assert.match(
    migration,
    /SET "revokedAt" = GREATEST\(CURRENT_TIMESTAMP, "createdAt"\)[\s\S]*?"subjectMembershipId" = OLD\."id"/,
  );
});

test("grant scopes are exact, tenant-bound, and deferred for safe tenant removal", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /AccessGrant_guard_lifecycle/);
  assert.match(migration, /AccessGrant requires an exact live membership/);
  assert.match(migration, /AccessGrant authority fields are immutable/);
  assert.match(migration, /AccessGrant revocation is irreversible/);
  assert.match(migration, /AccessGrant membership binding is immutable/);
  assert.match(
    migration,
    /CONSTRAINT "AccessGrant_live_binding" CHECK \([\s\S]*?"subjectMembershipId" IS NOT NULL OR "revokedAt" IS NOT NULL/,
  );
  const scopeShape = migration.match(
    /CONSTRAINT "AccessGrant_scope_shape" CHECK \([\s\S]*?\n  \),/,
  )?.[0];
  assert.ok(scopeShape);
  for (const scope of ["ORGANIZATION", "LOCATION", "SCREEN_GROUP", "SCREEN"])
    assert.match(scopeShape, new RegExp(`"scopeType" = '${scope}'`));

  for (const constraint of [
    "ScreenGroupMember_group_fkey",
    "ScreenGroupMember_screen_fkey",
    "AccessGrant_subject_fkey",
    "AccessGrant_subject_membership_fkey",
    "AccessGrant_creator_fkey",
    "AccessGrant_location_fkey",
    "AccessGrant_screenGroup_fkey",
    "AccessGrant_screen_fkey",
  ]) {
    const definition = migration.match(
      new RegExp(
        `ADD CONSTRAINT "${constraint}"[\\s\\S]*?DEFERRABLE INITIALLY DEFERRED`,
      ),
    )?.[0];
    assert.ok(definition, `${constraint} must be deferred`);
    if (constraint === "AccessGrant_subject_membership_fkey")
      assert.match(
        definition,
        /ON DELETE SET NULL \("subjectMembershipId"\) ON UPDATE NO ACTION/,
      );
    else assert.match(definition, /ON DELETE NO ACTION ON UPDATE CASCADE/);
  }
});
