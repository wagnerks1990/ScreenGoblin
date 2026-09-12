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
const demoPlaylistName = "High School Hallways";
const demoScheduleName = "School Day Baseline";

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

async function liveHeaders(page: Page) {
  const accessToken = await page.evaluate(() =>
    window.sessionStorage.getItem("sg_access_token"),
  );
  expect(accessToken).toBeTruthy();
  return { Authorization: `Bearer ${accessToken}` };
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
  await pairingDialog
    .getByRole("button", { name: "Close", exact: true })
    .click();

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

test("the live dashboard reads screens once per load and refreshes explicitly", async ({
  page,
}) => {
  await loginAsSeededOwner(page);
  await expect(page.getByText("Live API data")).toBeVisible();

  let screenReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/v1/screens") {
      screenReads += 1;
    }
  });

  await page.reload();
  await expect(page.getByText("Live API data")).toBeVisible();
  await expect.poll(() => screenReads).toBe(1);
  await expect(
    page.getByText("Live activity reporting is unavailable in this pilot."),
  ).toBeVisible();
  await expect(
    page.getByText("Current screen screenshots are unavailable in this pilot"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Refresh screen data" }).click();
  await expect.poll(() => screenReads).toBe(2);
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

test("authenticated playlists render live definitions without fixture or mutation affordances", async ({
  page,
}) => {
  await loginAsSeededOwner(page);
  const headers = await liveHeaders(page);
  const playlistName = `Chromium read-only playlist ${Date.now()}`;
  const created = await page.request.post(`${apiBaseUrl}/playlists`, {
    headers,
    data: { name: playlistName, description: "E2E API fixture", items: [] },
  });
  expect(created.status()).toBe(201);
  const playlist = (await created.json()) as { id: string };

  try {
    await page.goto("/playlists");
    await expect(page.getByText("Live API data")).toBeVisible();
    await expect(page.getByText(playlistName, { exact: true })).toBeVisible();
    await expect(page.getByText(demoPlaylistName, { exact: true })).toHaveCount(
      0,
    );
    const pageContent = page.locator("#main-content");
    await expect(
      pageContent.getByRole("button", {
        name: /new|edit|delete|preview|options/i,
      }),
    ).toHaveCount(0);
    await expect(pageContent.getByText(/Assigned to/i)).toHaveCount(0);
  } finally {
    const removed = await page.request.delete(
      `${apiBaseUrl}/playlists/${encodeURIComponent(playlist.id)}`,
      { headers },
    );
    expect(removed.status()).toBe(204);
  }
});

test("authenticated schedules mirror the live collection without inferred state", async ({
  page,
}) => {
  await loginAsSeededOwner(page);
  const headers = await liveHeaders(page);
  const response = await page.request.get(`${apiBaseUrl}/schedules`, {
    headers,
  });
  expect(response).toBeOK();
  const schedules = (await response.json()) as {
    data: Array<{ name: string; enabled: boolean }>;
  };

  await page.goto("/schedules");
  await expect(page.getByText("Live API data")).toBeVisible();
  if (schedules.data[0]) {
    await expect(
      page.getByText(schedules.data[0].name, { exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("heading", { name: "No schedules" }),
    ).toBeVisible();
  }
  await expect(page.getByText(demoScheduleName, { exact: true })).toHaveCount(
    0,
  );
  const pageContent = page.locator("#main-content");
  await expect(
    pageContent.getByRole("button", {
      name: /new|publish|withdraw|options/i,
    }),
  ).toHaveCount(0);
  for (const inferred of ["Active", "Upcoming", "Draft", "Published"])
    await expect(pageContent.getByText(inferred, { exact: true })).toHaveCount(
      0,
    );
});
