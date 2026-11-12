import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const apiBaseUrl =
  process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1";

function requiredOwnerCredentials() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.E2E_OWNER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "The Console E2E bootstrap setup did not provide owner credentials",
    );
  }
  return { email, password };
}

async function loginAsSeededOwner(page: Page) {
  const owner = requiredOwnerCredentials();
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect live" }),
  ).toBeVisible();
}

async function liveHeaders(page: Page) {
  const accessToken = await page.evaluate(() =>
    window.sessionStorage.getItem("sg_access_token"),
  );
  expect(accessToken).toBeTruthy();
  return { Authorization: `Bearer ${accessToken}` };
}

async function expectNoWcag21AAViolations(page: Page, state: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.flatMap((node) => node.target),
  }));
  expect(summary, `${state} accessibility violations`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/dashboard");
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
});

test("bootstrap password rotation meets automated WCAG 2.1 A/AA checks", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accessToken: "rotation-only-token",
        nextAction: "CHANGE_BOOTSTRAP_PASSWORD",
        changeBefore: "2030-01-01T00:15:00.000Z",
      }),
    });
  });
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("bootstrap-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Change bootstrap password" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expectNoWcag21AAViolations(page, "bootstrap password rotation");
  await expect(
    page.evaluate(() => window.sessionStorage.getItem("sg_access_token")),
  ).resolves.toBeNull();
});

test("sign-in and live workspace states meet automated WCAG 2.1 A/AA checks", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Sign in to ScreenGoblin" }),
  ).toBeVisible();
  await expectNoWcag21AAViolations(page, "sign-in page");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await loginAsSeededOwner(page);
  await page.getByRole("link", { name: "Screen fleet" }).click();
  await expect(page.getByText("Live API data")).toBeVisible();
  await expectNoWcag21AAViolations(page, "live fleet");

  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("Live API data")).toBeVisible();
  await expectNoWcag21AAViolations(page, "live dashboard");

  const headers = await liveHeaders(page);
  const playlistName = `Accessibility playlist ${Date.now()}`;
  const created = await page.request.post(`${apiBaseUrl}/playlists`, {
    headers,
    data: { name: playlistName, description: "", items: [] },
  });
  expect(created.status()).toBe(201);
  const playlist = (await created.json()) as { id: string };

  try {
    await page.getByRole("link", { name: "Playlists" }).click();
    await expect(page.getByText("Live API data")).toBeVisible();
    await expectNoWcag21AAViolations(page, "live playlists");
    await page.getByRole("button", { name: `View ${playlistName}` }).click();
    await expect(
      page.getByRole("dialog", { name: playlistName }),
    ).toBeVisible();
    await expectNoWcag21AAViolations(page, "live playlist drawer");
    await page.getByRole("button", { name: "Close details" }).click();
  } finally {
    const removed = await page.request.delete(
      `${apiBaseUrl}/playlists/${encodeURIComponent(playlist.id)}`,
      { headers },
    );
    expect(removed.status()).toBe(204);
  }

  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByText("Live API data")).toBeVisible();
  await expectNoWcag21AAViolations(page, "live schedules");

  await page.getByRole("link", { name: "Release review" }).click();
  await expect(page.getByText("Live API data")).toBeVisible();
  await expectNoWcag21AAViolations(page, "live release review");
});

test("skip navigation and modal and drawer focus containment work in Chromium", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await loginAsSeededOwner(page);
  await page.reload();
  await expect(page.getByRole("navigation")).toBeVisible();
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  await skipLink.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  await expect(page.locator("#main-content")).toBeFocused();

  await page.route("**/api/v1/screens", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: "keyboard-screen",
            name: "Keyboard test screen",
            location: "Test location",
            status: "offline",
            orientation: "landscape",
            resolution: "1920 × 1080",
            lastSeenAt: null,
            playerVersion: "1.0.0",
            tags: [],
          },
        ],
      }),
    }),
  );
  await page.getByRole("link", { name: "Screen fleet" }).click();
  const modalOpener = page.getByRole("button", { name: "Pair a screen" });
  await modalOpener.click();
  const modal = page.getByRole("dialog", { name: "Pair a screen" });
  await expect(modal).toBeFocused();
  await expectNoWcag21AAViolations(page, "authenticated enrollment dialog");
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#root")).toHaveJSProperty("inert", true);
  const modalClose = modal.getByRole("button", { name: "Close dialog" });
  const modalLast = modal.getByRole("button", { name: "Cancel", exact: true });
  await modalClose.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(modalLast).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modalClose).toBeFocused();
  await page
    .locator("#root")
    .evaluate((root) =>
      (
        root.querySelector<HTMLElement>("button") as HTMLElement | null
      )?.focus(),
    );
  await expect(modalClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(page.locator("#root")).toHaveJSProperty("inert", false);
  await expect(modalOpener).toBeFocused();

  await page.getByRole("link", { name: "Screen fleet" }).click();
  const drawerOpener = page.getByRole("button", {
    name: "View Keyboard test screen",
  });
  await drawerOpener.click();
  const drawer = page.getByRole("dialog", { name: "Keyboard test screen" });
  await expect(drawer).toBeFocused();
  await expectNoWcag21AAViolations(page, "authenticated fleet drawer");
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#root")).toHaveJSProperty("inert", true);
  const drawerClose = drawer.getByRole("button", { name: "Close details" });
  await drawerClose.focus();
  await page.keyboard.press("Tab");
  await expect(drawerClose).toBeFocused();
  await page
    .locator("#root")
    .evaluate((root) =>
      (
        root.querySelector<HTMLElement>("button") as HTMLElement | null
      )?.focus(),
    );
  await expect(drawerClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(page.locator("#root")).toHaveJSProperty("inert", false);
  await expect(drawerOpener).toBeFocused();
});
