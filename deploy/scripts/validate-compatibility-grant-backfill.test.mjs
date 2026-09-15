import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migrationUrl = new URL(
  "apps/api/prisma/migrations/20260915230000_compatibility_grant_backfill/migration.sql",
  root,
);
const policyUrl = new URL("apps/api/src/authorization/compatibility.ts", root);
const contractsUrl = new URL("packages/contracts/src/index.ts", root);

const roles = ["OWNER", "ADMIN", "PUBLISHER", "VIEWER"];

test("compatibility SQL exactly mirrors the reviewed role bundle source", async () => {
  const [migration, policy, contracts] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(policyUrl, "utf8"),
    readFile(contractsUrl, "utf8"),
  ]);
  const capabilityObject = contracts.match(
    /export const CAPABILITIES = \{([\s\S]*?)\n\} as const;/,
  )?.[1];
  assert.ok(capabilityObject);
  const capabilityValues = new Map(
    [...capabilityObject.matchAll(/(\w+):\s*"([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const sourcePairs = [];
  for (const role of roles) {
    const block = policy.match(
      new RegExp(`${role}: \\[([\\s\\S]*?)\\n  \\]`),
    )?.[1];
    assert.ok(block, `${role} compatibility bundle is missing`);
    for (const match of block.matchAll(/CAPABILITIES\.(\w+)/g)) {
      const capability = capabilityValues.get(match[1]);
      assert.ok(capability, `unknown contract capability ${match[1]}`);
      sourcePairs.push(`${role}|${capability}`);
    }
  }
  const valuesBlock = migration.match(
    /INSERT INTO "_compatibility_role_capability"[\s\S]*?VALUES([\s\S]*?);/,
  )?.[1];
  assert.ok(valuesBlock);
  const sqlPairs = [
    ...valuesBlock.matchAll(/\('(OWNER|ADMIN|PUBLISHER|VIEWER)', '([^']+)'\)/g),
  ].map((match) => `${match[1]}|${match[2]}`);
  assert.deepEqual(sqlPairs.sort(), sourcePairs.sort());
  assert.equal(new Set(sqlPairs).size, sqlPairs.length);
  assert.doesNotMatch(valuesBlock, /authorization\.manage|emergency\./);
});

test("backfill is exact, bounded, provenance-safe, and runtime-neutral", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /AccessGrantCreatorKind.*USER.*SYSTEM/s);
  assert.match(
    migration,
    /AccessGrant_creator_shape[\s\S]*creatorKind" = 'USER'[\s\S]*creatorKind" = 'SYSTEM'[\s\S]*legacy-role-backfill-v1/,
  );
  assert.match(
    migration,
    /creatorKind" = 'SYSTEM'[\s\S]*createdBySystemKey" IS NOT NULL[\s\S]*createdBySystemKey" = 'legacy-role-backfill-v1'/,
  );
  assert.match(
    migration,
    /NEW\."creatorKind"[\s\S]*NEW\."createdByUserId"[\s\S]*NEW\."createdBySystemKey"/,
  );
  assert.match(migration, /LOCK TABLE "Membership" IN EXCLUSIVE MODE/);
  assert.ok(
    migration.indexOf('LOCK TABLE "Membership" IN EXCLUSIVE MODE') <
      migration.indexOf('ALTER TABLE "AccessGrant"'),
    "Membership writers must be blocked before AccessGrant DDL takes its lock",
  );
  assert.match(migration, /ON CONFLICT \("id"\) DO NOTHING/);
  assert.match(
    migration,
    /Compatibility AccessGrant backfill verification failed/,
  );
  assert.match(migration, /compat-v1:' \|\| encode\(sha256\(convert_to\(/);
  assert.doesNotMatch(migration, /\bmd5\s*\(/i);
  assert.match(migration, /membership\."organizationId"/);
  assert.match(migration, /membership\."authorizationEpoch"/);
  assert.doesNotMatch(migration, /UPDATE\s+"Membership"/i);
  assert.doesNotMatch(migration, /UPDATE\s+"UserSession"/i);
  assert.doesNotMatch(migration, /Organization_authorizationMode_foundation/);
  assert.doesNotMatch(migration, /'SHADOW'|'SCOPED'/);
});
