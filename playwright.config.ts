import { defineConfig, devices } from "@playwright/test";
import { assertE2eEnvironment } from "./e2e/setup-safety.mjs";

// Validate before Playwright can start servers or execute mutating fixtures.
assertE2eEnvironment(process.env);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  outputDir: "/tmp/screengoblin-playwright",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "npm run start -w @screengoblin/api",
      url: "http://127.0.0.1:3000/health/live",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run preview -w @screengoblin/console",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
