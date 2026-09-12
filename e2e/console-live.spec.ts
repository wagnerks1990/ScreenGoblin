import { expect, test, type Page } from "@playwright/test";

const apiBaseUrl =
  process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1";
const liveScreenName = "Chromium E2E Screen";
const demoScreenNames = [
  "Main Lobby",
  "East Hall 01",
  "Cafeteria Menu",
  "Library Welcome",
  "Auditorium Lobby",
  "District Office",
];

function requiredOwnerCredentials() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required for Console E2E tests",
    );
  }
  return { email, password };
}

async function clearBrowserSession(page: Page) {
  await page.goto("/dashboard");
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
}

async function loginAsSeededOwner(page: Page) {
  const owner = requiredOwnerCredentials();
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /connect live/i }).click();
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Connect live" }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect live" }),
  ).toBeVisible();
}

async function ensureLiveScreen(page: Page) {
  const accessToken = await page.evaluate(() =>
    window.sessionStorage.getItem("sg_access_token"),
  );
  expect(accessToken).toBeTruthy();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const listResponse = await page.request.get(`${apiBaseUrl}/screens`, {
    headers,
  });
  expect(listResponse).toBeOK();
  const listed = (await listResponse.json()) as {
    data: Array<{ name: string }>;
  };
  if (listed.data.some((screen) => screen.name === liveScreenName)) return;

  const createResponse = await page.request.post(`${apiBaseUrl}/screens`, {
    headers,
    data: {
      name: liveScreenName,
      location: "Automated browser fixture",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: ["e2e"],
    },
  });
  expect(createResponse).toBeOK();
}

test.beforeEach(async ({ page }) => {
  await clearBrowserSession(page);
});

test("an owner connects to live fleet data, creates a pairing code, and disconnects", async ({
  page,
}) => {
  await loginAsSeededOwner(page);
  await ensureLiveScreen(page);

  await page.goto("/screens");
  await expect(page.getByText("Live API data")).toBeVisible();
  await expect(
    page.getByRole("cell", { name: liveScreenName, exact: true }),
  ).toBeVisible();

  const pairingResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${apiBaseUrl}/pairing-codes`,
  );
  await page.getByRole("button", { name: "Pair a screen" }).click();
  const pairingDialog = page.getByRole("dialog", { name: "Pair a screen" });
  await expect(pairingDialog).toBeVisible();
  expect((await pairingResponse).status()).toBe(201);
  await expect
    .poll(async () => {
      const code = await pairingDialog
        .locator(".pairing-result strong")
        .textContent();
      return /^\d{6}$/.test(code ?? "");
    })
    .toBe(true);
  await pairingDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Disconnect live" }).click();
  await expect(
    page.getByRole("button", { name: /demo data.*connect live/i }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        token: window.sessionStorage.getItem("sg_access_token"),
        user: window.sessionStorage.getItem("sg_session_user"),
      })),
    )
    .toEqual({ token: null, user: null });
});

test("a screens 401 clears the live session and never substitutes demo fleet records", async ({
  page,
}) => {
  await loginAsSeededOwner(page);
  await ensureLiveScreen(page);
  await page.goto("/screens");
  await expect(page.getByText("Live API data")).toBeVisible();
  await expect(
    page.getByRole("cell", { name: liveScreenName, exact: true }),
  ).toBeVisible();

  await page.route(
    "**/api/v1/screens",
    async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        }),
      });
    },
    { times: 1 },
  );
  await page.reload();

  await expect(page.getByRole("alert")).toContainText(
    "Live screen data is unavailable",
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({
        token: window.sessionStorage.getItem("sg_access_token"),
        user: window.sessionStorage.getItem("sg_session_user"),
      })),
    )
    .toEqual({ token: null, user: null });
  await expect(
    page.getByText("Clearly labeled demonstration data"),
  ).toHaveCount(0);
  for (const name of demoScreenNames) {
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  }
});
