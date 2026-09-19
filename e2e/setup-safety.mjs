const API_BASE_URL = "http://127.0.0.1:3000/api/v1";
const MEDIA_ORIGIN = "http://127.0.0.1:4173";
const ORGANIZATION_SLUG = "screengoblin-e2e";
const DATABASE_URL_PATTERN =
  /^postgres(?:ql)?:\/\/[^/?#\s]+\/screengoblin_e2e(?:\?schema=public)?$/;
const LOGIN_BUDGET_WINDOW_MS = 60_000;
const LOGIN_BUDGET_SAFETY_MS = 500;

export function assertE2eEnvironment(environment) {
  if (
    environment.NODE_ENV !== "test" ||
    environment.SCREEN_GOBLIN_ALLOW_E2E_MUTATIONS !== "true"
  ) {
    throw new Error(
      "Browser tests require NODE_ENV=test and SCREEN_GOBLIN_ALLOW_E2E_MUTATIONS=true",
    );
  }

  // Check the raw spelling as well as the parsed authority. Do not accept
  // driver-specific host/database/schema overrides or URL normalization tricks.
  const databaseUrl = environment.DATABASE_URL;
  if (
    typeof databaseUrl !== "string" ||
    !DATABASE_URL_PATTERN.test(databaseUrl)
  ) {
    throw new Error(
      "Browser tests require the isolated screengoblin_e2e database",
    );
  }
  let database;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error("Browser test database configuration is invalid");
  }
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(database.hostname)) {
    throw new Error("Browser test database must use a loopback host");
  }

  const requiredValues = {
    MEDIA_ALLOWED_ORIGINS: MEDIA_ORIGIN,
    SEED_ORGANIZATION_SLUG: ORGANIZATION_SLUG,
  };
  const optionalValues = {
    E2E_API_BASE_URL: API_BASE_URL,
    VITE_API_BASE_URL: API_BASE_URL,
    PUBLIC_API_URL: "http://127.0.0.1:3000",
    HOST: "127.0.0.1",
    PORT: "3000",
  };
  for (const [name, value] of Object.entries(requiredValues)) {
    if (environment[name] !== value)
      throw new Error(`${name} must use the isolated browser fixture target`);
  }
  for (const [name, value] of Object.entries(optionalValues)) {
    if (environment[name] !== undefined && environment[name] !== value)
      throw new Error(`${name} must match the local Playwright servers`);
  }
  return Object.freeze({
    apiBaseUrl: API_BASE_URL,
    mediaOrigin: MEDIA_ORIGIN,
    organizationSlug: ORGANIZATION_SLUG,
  });
}

export async function waitForFreshLoginBudgetWindow(
  firstLoginCompletedAt,
  {
    now = () => performance.now(),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!Number.isFinite(firstLoginCompletedAt) || firstLoginCompletedAt < 0)
    throw new Error(
      "The completed-login timestamp must be monotonic and finite",
    );
  // Starting after receipt of the first response is conservative even when
  // connecting/sending the request was delayed. Wall-clock changes cannot
  // shorten this wait, and early timer wakeups must not consume the safety floor.
  while (true) {
    const elapsed = now() - firstLoginCompletedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw new Error("The login-budget clock must be monotonic and finite");
    const remaining = LOGIN_BUDGET_WINDOW_MS + LOGIN_BUDGET_SAFETY_MS - elapsed;
    if (remaining <= 0) return;
    await sleep(remaining);
  }
}
