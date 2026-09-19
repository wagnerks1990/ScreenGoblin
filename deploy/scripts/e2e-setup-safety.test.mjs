import assert from "node:assert/strict";
import test from "node:test";
import {
  assertE2eEnvironment,
  waitForFreshLoginBudgetWindow,
} from "../../e2e/setup-safety.mjs";

const environment = () => ({
  NODE_ENV: "test",
  SCREEN_GOBLIN_ALLOW_E2E_MUTATIONS: "true",
  DATABASE_URL:
    "postgresql://fixture:fixture-only@127.0.0.1:5432/screengoblin_e2e?schema=public",
  MEDIA_ALLOWED_ORIGINS: "http://127.0.0.1:4173",
  SEED_ORGANIZATION_SLUG: "screengoblin-e2e",
});

test("accepts only the isolated database and fixed browser targets", () => {
  for (const protocol of ["postgres", "postgresql"]) {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      for (const query of ["", "?schema=public"]) {
        const targets = assertE2eEnvironment({
          ...environment(),
          DATABASE_URL: `${protocol}://fixture:fixture-only@${host}:5432/screengoblin_e2e${query}`,
        });
        assert.deepEqual(targets, {
          apiBaseUrl: "http://127.0.0.1:3000/api/v1",
          mediaOrigin: "http://127.0.0.1:4173",
          organizationSlug: "screengoblin-e2e",
        });
        assert.equal(Object.isFrozen(targets), true);
      }
    }
  }
});

test("requires explicit test mode and mutation acknowledgement", () => {
  for (const NODE_ENV of [undefined, "development", "production", "TEST"]) {
    assert.throws(() => assertE2eEnvironment({ ...environment(), NODE_ENV }));
  }
  for (const acknowledgement of [undefined, "false", "TRUE", "1", " true "]) {
    assert.throws(() =>
      assertE2eEnvironment({
        ...environment(),
        SCREEN_GOBLIN_ALLOW_E2E_MUTATIONS: acknowledgement,
      }),
    );
  }
});

test("rejects ambiguous URLs without echoing credentials", () => {
  const secret = "must-not-appear-in-errors";
  const base = `postgresql://fixture:${secret}@127.0.0.1:5432/`;
  const invalid = [
    undefined,
    "",
    "not a URL",
    `${base}screengoblin`,
    `${base}screengoblin_test`,
    `${base}screengoblin_e2e/`,
    `${base}screengoblin_e2e#fragment`,
    `${base}screengoblin_e2e?schema=private`,
    `${base}screengoblin_e2e?schema=public&schema=private`,
    `${base}screengoblin_e2e?host=database.example.test`,
    `${base}screengoblin_e2e?schema=public&host=/var/run/postgresql`,
    `${base}screengoblin_e2e?options=--search_path=private`,
    `${base}screengoblin_e2e?%73chema=public`,
    `${base}screengoblin_e2e?schema=public&`,
    `${base}production/../screengoblin_e2e`,
    `${base}%73creengoblin_e2e`,
    `${base}screengoblin_e2e\n`,
    ` ${base}screengoblin_e2e`,
    `${base}screengoblin_e2e`.replace("postgresql:", "https:"),
    `${base}screengoblin_e2e`.replace("127.0.0.1", "database.example.test"),
    `${base}screengoblin_e2e`.replace("127.0.0.1", "localhost.example.test"),
    `${base}screengoblin_e2e`.replace("127.0.0.1", "0.0.0.0"),
    `${base}screengoblin_e2e`.replace("127.0.0.1", "127.1"),
    `${base}screengoblin_e2e`.replace("127.0.0.1", "%31%32%37.0.0.1"),
    `${base}screengoblin_e2e`.replace("127.0.0.1", "[::ffff:127.0.0.1]"),
    `${base}screengoblin_e2e`.replace(":5432", ":invalid"),
  ];
  for (const DATABASE_URL of invalid) {
    assert.throws(
      () => assertE2eEnvironment({ ...environment(), DATABASE_URL }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test("rejects alternate fixture origins, tenants, and server overrides", () => {
  for (const [name, values] of Object.entries({
    MEDIA_ALLOWED_ORIGINS: [
      undefined,
      "https://media.example.test",
      "http://127.0.0.1:4173,http://127.0.0.1:3000",
      "http://127.0.0.1:4173/path",
    ],
    SEED_ORGANIZATION_SLUG: [undefined, "production", " screengoblin-e2e "],
    E2E_API_BASE_URL: [
      "https://api.example.test/api/v1",
      "http://127.0.0.1:3001/api/v1",
    ],
    VITE_API_BASE_URL: ["https://api.example.test/api/v1"],
    PUBLIC_API_URL: ["https://api.example.test"],
    HOST: ["0.0.0.0"],
    PORT: ["3001"],
  })) {
    for (const value of values)
      assert.throws(() =>
        assertE2eEnvironment({ ...environment(), [name]: value }),
      );
  }
});

test("waits a complete window after a delayed first response", async () => {
  // The first request was sent at 0 but reached the server only much later.
  let monotonicNow = 10_000;
  const firstLoginCompletedAt = monotonicNow;
  monotonicNow += 2_000;
  const waits = [];
  await waitForFreshLoginBudgetWindow(firstLoginCompletedAt, {
    now: () => monotonicNow,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      monotonicNow += milliseconds;
    },
  });
  assert.deepEqual(waits, [58_500]);
  assert.equal(monotonicNow, firstLoginCompletedAt + 60_500);
});

test("preserves the floor after an early timer wakeup", async () => {
  let monotonicNow = 10;
  const waits = [];
  await waitForFreshLoginBudgetWindow(monotonicNow, {
    now: () => monotonicNow,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      monotonicNow += waits.length === 1 ? milliseconds - 100 : milliseconds;
    },
  });
  assert.deepEqual(waits, [60_500, 100]);
  assert.equal(monotonicNow, 60_510);
});

test("avoids sleeping after the completed-response window", async () => {
  await waitForFreshLoginBudgetWindow(100, {
    now: () => 60_600,
    sleep: async () => assert.fail("no wait should be necessary"),
  });
});

test("rejects invalid or backwards monotonic clocks", async () => {
  for (const timestamp of [NaN, Infinity, -1]) {
    await assert.rejects(waitForFreshLoginBudgetWindow(timestamp));
  }
  for (const current of [NaN, Infinity, 99]) {
    await assert.rejects(
      waitForFreshLoginBudgetWindow(100, { now: () => current }),
    );
  }
});
