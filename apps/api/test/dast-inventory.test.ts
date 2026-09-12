import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";

interface InventoryRoute {
  label: string;
  method: string;
  template: string;
  seedPath: string;
}

describe("runtime DAST API inventory", () => {
  it("matches every registered public API route and the live health route", async () => {
    const registered = new Set<string>();
    const app = await buildApp({
      store: new MemoryStore(),
      jwtSecret: "dast-inventory-test-secret-at-least-thirty-two-characters",
      manifestSigningPrivateKey: Buffer.alloc(32, 5).toString("base64url"),
      pairingCodePepper:
        "dast-inventory-test-pepper-at-least-thirty-two-characters",
      deviceAuthMode: "development-bearer",
      onRoute: (route) => {
        const methods = Array.isArray(route.method)
          ? route.method
          : [route.method];
        for (const method of methods) {
          const normalizedMethod = method.toUpperCase();
          if (normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS")
            continue;
          if (route.url === "/health/ready") continue;
          if (route.url === "/health/live" || route.url.startsWith("/api/"))
            registered.add(`${normalizedMethod} ${route.url}`);
        }
      },
    });
    try {
      await app.ready();
      const inventory = JSON.parse(
        readFileSync(
          new URL(
            "../../../deploy/scripts/zap-runtime-inventory.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as {
        surfaces: { "console-api": { routes: InventoryRoute[] } };
      };
      const inventoried = new Set(
        inventory.surfaces["console-api"].routes
          .filter(
            (route) =>
              route.template.startsWith("/api/") ||
              route.template === "/health/live",
          )
          .map((route) => `${route.method} ${route.template}`),
      );
      expect([...inventoried].sort()).toEqual([...registered].sort());
    } finally {
      await app.close();
    }
  });
});
