import { describe, expect, it } from "vitest";
import {
  shellAssetsFromHtml,
  shellCacheName,
} from "./build-service-worker.mjs";

describe("service-worker build manifest", () => {
  it("extracts, sorts, and deduplicates canonical Vite assets", () => {
    const shell = shellAssetsFromHtml(`
      <link href="/assets/index-AbCdEf12.css" rel="stylesheet">
      <script src="/assets/index-ZyXwVu98.js"></script>
      <script src="/assets/index-ZyXwVu98.js"></script>
    `);

    expect(shell).toContain("/assets/index-AbCdEf12.css");
    expect(shell).toContain("/assets/index-ZyXwVu98.js");
    expect(shell).toEqual([...shell].sort());
    expect(shell.filter((path) => path.endsWith(".js"))).toHaveLength(1);
  });

  it.each([
    "/assets/../package.json",
    "/assets/%2e%2e%2fsecret-12345678.js",
    "/assets/app-12345678.js?tenant=one",
    "/assets/nested/app-12345678.js",
    "/assets/app.js",
    "/assets/app-12345678.html",
  ])("rejects a non-canonical generated path: %s", (path) => {
    expect(() =>
      shellAssetsFromHtml(`<script src="${path}"></script>`),
    ).toThrow("Unsafe generated shell asset path");
  });

  it("uses worker logic as part of cache generation", () => {
    const entries = [
      { path: "/", content: Buffer.from("same shell") },
      {
        path: "/assets/app-12345678.js",
        content: Buffer.from("same app"),
      },
    ];

    const prior = shellCacheName("worker logic v1", entries);
    const next = shellCacheName("worker logic v2", entries);

    expect(next).not.toBe(prior);
    expect(prior).toMatch(/^screengoblin-shell-[0-9a-f]{16}$/);
    expect(next).toMatch(/^screengoblin-shell-[0-9a-f]{16}$/);
  });
});
