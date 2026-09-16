import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migrationUrl = new URL(
  "apps/api/prisma/migrations/20260916110000_bootstrap_password_containment/migration.sql",
  root,
);
const schemaUrl = new URL("apps/api/prisma/schema.prisma", root);
const seedUrl = new URL("apps/api/prisma/seed.ts", root);
const seedPasswordUrl = new URL("apps/api/prisma/seed-password.ts", root);
const temporaryPasswordPolicyUrl = new URL(
  "apps/api/src/identity/temporary-password-policy.ts",
  root,
);
const composeUrl = new URL("docker-compose.yml", root);
const playwrightConfigUrl = new URL("playwright.config.ts", root);
const playwrightSetupUrl = new URL("e2e/global-setup.ts", root);
const consoleLiveUrl = new URL("e2e/console-live.spec.ts", root);
const consoleAccessibilityUrl = new URL(
  "e2e/console-accessibility.spec.ts",
  root,
);
const dastInventoryUrl = new URL(
  "deploy/scripts/zap-runtime-inventory.json",
  root,
);

test("bootstrap session purposes and database limits remain fail closed", async () => {
  const [migration, schema] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(schemaUrl, "utf8"),
  ]);
  for (const source of [migration, schema]) {
    assert.match(source, /UserSessionPurpose/);
    assert.match(source, /\bFULL\b/);
    assert.match(source, /BOOTSTRAP_PASSWORD_ROTATION/);
  }
  assert.match(migration, /LOCK TABLE "User" IN EXCLUSIVE MODE/);
  assert.match(migration, /LOCK TABLE "UserSession" IN EXCLUSIVE MODE/);
  assert.ok(
    migration.indexOf('LOCK TABLE "User" IN EXCLUSIVE MODE') <
      migration.indexOf('LOCK TABLE "UserSession" IN EXCLUSIVE MODE'),
  );
  assert.match(migration, /UserSession_purpose_max_lifetime/);
  assert.match(migration, /"expiresAt" > "createdAt"/);
  assert.match(migration, /INTERVAL '1 hour'/);
  assert.match(migration, /INTERVAL '10 minutes'/);
  assert.match(migration, /NEW\."expiresAt" <= CURRENT_TIMESTAMP/);
  assert.match(migration, /FOR KEY SHARE/);
  assert.match(
    migration,
    /NEW\."purpose" = 'FULL'[\s\S]*bootstrap_deadline IS NOT NULL[\s\S]*RAISE EXCEPTION/,
  );
  assert.match(
    migration,
    /bootstrap_deadline IS NULL[\s\S]*bootstrap_deadline <= CURRENT_TIMESTAMP[\s\S]*NEW\."expiresAt" > bootstrap_deadline[\s\S]*RAISE EXCEPTION/,
  );
  assert.match(migration, /BEFORE INSERT OR UPDATE/);
});

test("Compose can interpolate without retained bootstrap secrets while explicit seeding fails closed", async () => {
  const compose = await readFile(composeUrl, "utf8");
  for (const name of [
    "SEED_ADMIN_EMAIL",
    "SEED_ADMIN_PASSWORD",
    "SEED_ADMIN_NAME",
    "SEED_ORGANIZATION_NAME",
    "SEED_ORGANIZATION_SLUG",
  ]) {
    assert.ok(compose.includes(`${name}: \${${name}:-}`));
    assert.ok(!compose.includes(`\${${name}:?`));
  }

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `import(${JSON.stringify(seedPasswordUrl.href)}).then(({ readSeedEnvironment }) => readSeedEnvironment({}))`,
    ],
    {
      cwd: fileURLToPath(root),
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SEED_ADMIN_EMAIL is required/);
});

test("browser E2E setup rotates once and reuses a deterministic non-logged credential", async () => {
  const [config, setup, live, accessibility] = await Promise.all([
    readFile(playwrightConfigUrl, "utf8"),
    readFile(playwrightSetupUrl, "utf8"),
    readFile(consoleLiveUrl, "utf8"),
    readFile(consoleAccessibilityUrl, "utf8"),
  ]);
  assert.match(config, /globalSetup: "\.\/e2e\/global-setup\.ts"/);
  assert.match(setup, /createHmac\("sha256", owner\.password\)/);
  assert.match(setup, /loginResponse\.status !== 401/);
  assert.match(setup, /process\.env\.E2E_OWNER_PASSWORD = replacementPassword/);
  assert.doesNotMatch(setup, /console\.(?:log|error|warn)/);
  for (const spec of [live, accessibility]) {
    assert.match(spec, /process\.env\.E2E_OWNER_PASSWORD/);
    assert.doesNotMatch(spec, /process\.env\.SEED_ADMIN_PASSWORD/);
  }
});

test("runtime DAST inventory includes bootstrap password rotation", async () => {
  const inventory = JSON.parse(await readFile(dastInventoryUrl, "utf8"));
  assert.deepEqual(
    inventory.surfaces["console-api"].routes.filter(
      (route) => route.label === "auth-bootstrap-password",
    ),
    [
      {
        label: "auth-bootstrap-password",
        method: "POST",
        template: "/api/v1/auth/bootstrap-password",
        seedPath: "/api/v1/auth/bootstrap-password",
      },
    ],
  );
});

test("seed containment is atomic, database-clock-bound, and idempotent", async () => {
  const [seed, seedPassword, temporaryPasswordPolicy] = await Promise.all([
    readFile(seedUrl, "utf8"),
    readFile(seedPasswordUrl, "utf8"),
    readFile(temporaryPasswordPolicyUrl, "utf8"),
  ]);
  assert.match(seed, /readSeedEnvironment\(\)/);
  assert.ok(
    seed.indexOf("readSeedEnvironment()") < seed.indexOf("hash(password, 12)"),
  );
  assert.match(seedPassword, /validateSeedPassword\(password\)/);
  assert.ok(
    seedPassword.indexOf(
      'requiredSeedValue(environment, "SEED_ADMIN_PASSWORD")',
    ) < seedPassword.indexOf("validateSeedPassword(password)"),
  );
  assert.match(seedPassword, /validateTemporaryPassword/);
  assert.match(temporaryPasswordPolicy, /\[\.\.\.password\]\.length/);
  assert.match(
    temporaryPasswordPolicy,
    /Buffer\.byteLength\(password, "utf8"\)/,
  );
  assert.match(temporaryPasswordPolicy, /MAXIMUM_BCRYPT_PASSWORD_BYTES = 72/);
  assert.match(seed, /pg_advisory_xact_lock\(hashtextextended\(/);
  const lockIdentity = seed.match(
    /const bootstrapSeedLockIdentity =([\s\S]*?);/,
  )?.[1];
  assert.ok(lockIdentity);
  assert.match(lockIdentity, /email/);
  assert.doesNotMatch(lockIdentity, /organizationSlug/);
  assert.ok(
    seed.indexOf("pg_advisory_xact_lock") <
      seed.indexOf("tx.organization.upsert"),
  );
  assert.match(seed, /prisma\.\$transaction/);
  assert.match(seed, /CURRENT_TIMESTAMP \+ INTERVAL '24 hours'/);
  assert.match(seed, /compatibilityGrantCapabilities\("OWNER"\)/);
  assert.match(seed, /auth\.bootstrap_password_containment_enabled/);
  assert.match(seed, /actorType: "system"/);
  assert.match(seed, /await compare\(password, existing\.passwordHash\)/);
  assert.match(seed, /decideExistingBootstrapContainment/);
  assert.match(
    seedPassword,
    /Existing bootstrap owner is not containment-proven and the supplied seed password does not match; refusing to continue/,
  );
  assert.match(seed, /authenticationEpoch: \{ increment: 1 \}/);
  assert.match(seed, /userSession\.updateMany/);
  assert.match(seed, /auditEvent\.createMany/);
  assert.match(seed, /hasContainmentAudit: priorContainmentAudit !== null/);
  assert.doesNotMatch(
    seed,
    /existing[\s\S]{0,500}passwordHash:\s*passwordHash/,
  );
});
