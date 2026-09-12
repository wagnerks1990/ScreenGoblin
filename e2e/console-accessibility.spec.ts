import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const apiBaseUrl =
  process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1";

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

async function loginAsSeededOwner(page: Page) {
  const owner = requiredOwnerCredentials();
  await page.getByRole("button", { name: /connect live/i }).click();
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Connect live" }).click();
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

test("demo, dialog, drawer, and live fleet states meet automated WCAG 2.1 A/AA checks", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: /operations overview/i }),
  ).toBeVisible();
  await expectNoWcag21AAViolations(page, "demo dashboard");

  await page.getByRole("button", { name: /connect live/i }).click();
  await expect(
    page.getByRole("dialog", { name: /connect to screengoblin/i }),
  ).toBeVisible();
  await expectNoWcag21AAViolations(page, "login dialog");
  await page.getByRole("button", { name: "Keep demo mode" }).click();

  await page.getByRole("link", { name: "Screen fleet" }).click();
  await expect(
    page.getByText("Clearly labeled demonstration data"),
  ).toBeVisible();
  await expectNoWcag21AAViolations(page, "demo fleet");

  await page.getByRole("button", { name: "View Main Lobby" }).click();
  await expect(page.getByRole("dialog", { name: "Main Lobby" })).toBeVisible();
  await expectNoWcag21AAViolations(page, "open fleet drawer");
  await page.getByRole("button", { name: "Close details" }).click();

  await loginAsSeededOwner(page);
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
});

test("skip navigation and modal and drawer focus containment work in Chromium", async ({
  page,
}) => {
  await page.goto("/dashboard");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  await skipLink.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  await expect(page.locator("#main-content")).toBeFocused();

  const modalOpener = page.getByRole("button", { name: /connect live/i });
  await modalOpener.click();
  const modal = page.getByRole("dialog", { name: /connect to screengoblin/i });
  await expect(modal).toBeFocused();
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#root")).toHaveJSProperty("inert", true);
  const modalClose = modal.getByRole("button", { name: "Close dialog" });
  const modalLast = modal.getByRole("button", { name: "Keep demo mode" });
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
  const drawerOpener = page.getByRole("button", { name: "View Main Lobby" });
  await drawerOpener.click();
  const drawer = page.getByRole("dialog", { name: "Main Lobby" });
  await expect(drawer).toBeFocused();
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
