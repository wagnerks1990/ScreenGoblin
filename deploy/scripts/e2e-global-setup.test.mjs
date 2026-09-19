import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import module, { syncBuiltinESMExports } from "node:module";
import { createHmac } from "node:crypto";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = await readFile(new URL("e2e/global-setup.ts", root), "utf8");
const stripped = module.stripTypeScriptTypes
  ? module.stripTypeScriptTypes(source)
  : (await import("typescript")).transpileModule(source, {
      compilerOptions: { module: 99, target: 99 },
    }).outputText;
const javascript = stripped.replace(
  '"./setup-safety.mjs"',
  JSON.stringify(new URL("e2e/setup-safety.mjs", root).href),
);
const { default: globalSetup } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

const validEnvironment = () => ({
  NODE_ENV: "test",
  SCREEN_GOBLIN_ALLOW_E2E_MUTATIONS: "true",
  DATABASE_URL:
    "postgresql://fixture:fixture-only@127.0.0.1:5432/screengoblin_e2e?schema=public",
  MEDIA_ALLOWED_ORIGINS: "http://127.0.0.1:4173",
  SEED_ORGANIZATION_SLUG: "screengoblin-e2e",
  SEED_ADMIN_EMAIL: "owner.e2e@example.test",
  SEED_ADMIN_PASSWORD: "fixture-only-owner-temporary-password",
  E2E_PUBLISHER_EMAIL: "publisher.e2e@example.test",
  E2E_PUBLISHER_TEMPORARY_PASSWORD: "fixture-only-publisher-temporary-password",
  E2E_ADMIN_EMAIL: "admin.e2e@example.test",
  E2E_ADMIN_TEMPORARY_PASSWORD: "fixture-only-admin-temporary-password",
});

async function isolatedSetup(environment, run) {
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;
  const originalCreateRequire = module.createRequire;
  const originalTimeout = globalThis.setTimeout;
  const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
  const effects = { clients: 0, assets: [], requests: [], sleeps: [] };
  let clock = 0;
  try {
    process.env = environment;
    module.createRequire = () => () => ({
      PrismaClient: class {
        constructor() {
          effects.clients += 1;
        }
        organization = {
          findUnique: async () => ({ id: "isolated-organization" }),
        };
        mediaAsset = {
          create: async (input) => effects.assets.push(input.data),
        };
        $disconnect = async () => {};
      },
    });
    syncBuiltinESMExports();
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => clock,
    });
    globalThis.setTimeout = (callback, milliseconds) => {
      effects.sleeps.push(milliseconds);
      clock += milliseconds;
      callback();
      return 0;
    };
    const logins = new Map();
    globalThis.fetch = async (url, options) => {
      effects.requests.push({ url, options });
      if (effects.requests.length === 1) clock = 10_000;
      if (url.endsWith("/auth/login")) {
        const { email } = JSON.parse(options.body);
        const count = (logins.get(email) ?? 0) + 1;
        logins.set(email, count);
        return new Response(
          JSON.stringify(
            count === 1
              ? {
                  nextAction: "CHANGE_BOOTSTRAP_PASSWORD",
                  accessToken: "fixture-bootstrap",
                }
              : { accessToken: "fixture-session", user: { email } },
          ),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    };
    await run(effects, () => clock);
  } finally {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    module.createRequire = originalCreateRequire;
    syncBuiltinESMExports();
    if (originalNow) Object.defineProperty(performance, "now", originalNow);
    else delete performance.now;
  }
}

test("rejects non-test databases before side effects", async () => {
  await isolatedSetup(
    {
      ...validEnvironment(),
      DATABASE_URL:
        "postgresql://fixture:fixture-only@127.0.0.1:5432/production",
    },
    async (effects) => {
      await assert.rejects(globalSetup({}), /isolated screengoblin_e2e/);
      assert.deepEqual(effects, {
        clients: 0,
        assets: [],
        requests: [],
        sleeps: [],
      });
    },
  );
});

test("rejects missing principals before fixture writes", async () => {
  const environment = validEnvironment();
  delete environment.E2E_ADMIN_EMAIL;
  await isolatedSetup(environment, async (effects) => {
    await assert.rejects(globalSetup({}), /E2E_ADMIN_EMAIL/);
    assert.deepEqual(effects, {
      clients: 0,
      assets: [],
      requests: [],
      sleeps: [],
    });
  });
});

test("rotates three principals and waits after the response", async () => {
  await isolatedSetup(validEnvironment(), async (effects, now) => {
    await globalSetup({});
    assert.equal(effects.clients, 1);
    assert.equal(effects.assets.length, 1);
    assert.equal(effects.assets[0].organizationId, "isolated-organization");
    assert.equal(effects.requests.length, 12);
    assert.equal(
      effects.requests.filter(({ url }) => url.endsWith("/auth/login")).length,
      6,
    );
    for (const { url, options } of effects.requests) {
      assert.equal(new URL(url).origin, "http://127.0.0.1:3000");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "POST");
      assert.ok(options.signal instanceof AbortSignal);
    }
    for (const [email, password, variable] of [
      [
        process.env.SEED_ADMIN_EMAIL,
        process.env.SEED_ADMIN_PASSWORD,
        "E2E_OWNER_PASSWORD",
      ],
      [
        process.env.E2E_PUBLISHER_EMAIL,
        process.env.E2E_PUBLISHER_TEMPORARY_PASSWORD,
        "E2E_PUBLISHER_PASSWORD",
      ],
      [
        process.env.E2E_ADMIN_EMAIL,
        process.env.E2E_ADMIN_TEMPORARY_PASSWORD,
        "E2E_ADMIN_PASSWORD",
      ],
    ]) {
      const expected = createHmac("sha256", password)
        .update(
          `screengoblin-console-e2e\0${email}\0http://127.0.0.1:3000/api/v1`,
        )
        .digest("base64url");
      assert.equal(process.env[variable], expected);
    }
    assert.deepEqual(effects.sleeps, [60_500]);
    assert.equal(now(), 70_500);
  });
});

test("guards configuration and refuses existing servers", async () => {
  const config = await readFile(new URL("playwright.config.ts", root), "utf8");
  assert.ok(
    config.indexOf("assertE2eEnvironment(process.env)") <
      config.indexOf("defineConfig({"),
  );
  assert.equal([...config.matchAll(/reuseExistingServer: false/g)].length, 2);
  assert.doesNotMatch(
    config,
    /reuseExistingServer: (?:true|!process\.env\.CI)/,
  );
});

test("CI validates browser targets before migrating or seeding", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/ci.yml", root),
    "utf8",
  );
  const browserJob = workflow
    .split("  browser-e2e:\n")[1]
    .split("\n  android:")[0];
  assert.match(browserJob, /SCREEN_GOBLIN_ALLOW_E2E_MUTATIONS: "true"/);
  const preflight = browserJob.indexOf(
    "Validate isolated browser fixture targets",
  );
  assert.ok(preflight >= 0);
  for (const command of ["prisma:migrate", "prisma:seed", "member:provision"]) {
    assert.ok(preflight < browserJob.indexOf(command));
  }
  assert.match(browserJob, /assertE2eEnvironment\(process\.env\)/);
});
