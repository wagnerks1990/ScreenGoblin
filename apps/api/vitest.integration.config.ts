import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["integration/**/*.integration.test.ts"],
    exclude: ["integration/runtime-role.integration.test.ts"],
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
