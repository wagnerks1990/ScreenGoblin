import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
for (const width of [390, 1280]) {
  test(`recovery form stays private and accessible at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/v1/auth/recovery-options", (route) =>
      route.fulfill({ json: { passwordResetEnabled: true } }),
    );
    let submissions = 0;
    await page.route("**/api/v1/auth/password-reset/request", (route) => {
      submissions++;
      expect(route.request().postDataJSON()).toEqual({
        email: "unknown@example.test",
      });
      expect(route.request().headers().authorization).toBeUndefined();
      return route.fulfill({
        status: 202,
        json: {
          message:
            "If an eligible account exists, instructions will be emailed.",
        },
      });
    });
    await page.goto("/forgot-password");
    await expect(
      page.getByRole("heading", { name: "Reset your password" }),
    ).toBeVisible();
    expect(submissions).toBe(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByLabel("Email").fill("unknown@example.test");
    await page.getByRole("button", { name: "Email reset link" }).click();
    await expect(page.getByRole("status")).toContainText(
      "If an eligible account exists",
    );
    expect(submissions).toBe(1);
  });
}
test("reset removes its fragment and requires explicit submission before changing a password", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/recovery-options", (route) =>
    route.fulfill({ json: { passwordResetEnabled: true } }),
  );
  let submissions = 0;
  const token = "a".repeat(43);
  await page.route("**/api/v1/auth/password-reset/confirm", (route) => {
    submissions++;
    expect(route.request().postDataJSON()).toEqual({
      token,
      newPassword: "browser-only-test-password",
    });
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/reset-password#token=" + token);
  await expect(
    page.getByRole("heading", { name: "Choose a new password" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/reset-password$/);
  expect(submissions).toBe(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page
    .getByLabel("New password", { exact: true })
    .fill("browser-only-test-password");
  await page
    .getByLabel("Confirm new password")
    .fill("browser-only-test-password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toContainText("Password changed");
  expect(submissions).toBe(1);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain(token);
});

for (const width of [390, 1280]) {
  test(`mail settings stay scoped and accessible at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const user = {
      id: "mail-owner",
      organizationId: "mail-org",
      email: "owner@example.test",
      role: "OWNER",
      name: "Mail Owner",
    };
    await page.addInitScript((user) => {
      sessionStorage.setItem("sg_access_token", "mail-browser-test-session");
      sessionStorage.setItem("sg_session_user", JSON.stringify(user));
    }, user);
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill({ json: { user: { ...user, sub: user.id } } }),
    );
    await page.route("**/api/v1/mail", (route) =>
      route.fulfill({
        json: {
          configured: true,
          receivingConfigured: true,
          workerHealthy: true,
          offlineMinutes: 10,
          from: "no-reply@signage.example.test",
          inbox: null,
          offlineAlertsEnabled: false,
          jobs: [
            {
              id: "test",
              kind: "TEST",
              status: "DELIVERED",
              createdAt: "2026-11-12T12:00:00Z",
            },
          ],
          received: [],
        },
      }),
    );
    await page.goto("/settings");
    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Delivery history" }),
    ).toBeVisible();
    await expect(
      page.getByLabel(
        "Email offline and recovery alerts to my sign-in address",
      ),
    ).not.toBeChecked();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `/tmp/screengoblin-playwright/mail-settings-${width}.png`,
      fullPage: true,
    });
  });
}
