import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productionSources = [
  "apps/api/src/routes/devices.ts",
  "apps/api/src/routes/media-delivery.ts",
  "apps/player/src/core/api.ts",
  "apps/player/src/core/assets.ts",
  "apps/player/src/core/manifest.ts",
  "apps/player/android/app/src/main/java/com/screengoblin/player/MediaCachePlugin.java",
  "apps/player/android/app/src/main/java/com/screengoblin/player/MediaCacheStore.java",
  "deploy/caddy/Caddyfile",
];

const currentProtocolDocs = [
  "AI-CONTEXT.md",
  "README.md",
  "apps/api/README.md",
  "apps/player/README.md",
  "apps/player/docs/PLAYER_PROTOCOL.md",
  "docs/API.md",
  "docs/DEVICE_PROTOCOL.md",
  "docs/RUNBOOK.md",
  "docs/THREAT_MODEL.md",
  "docs/governance/DATA-FLOW-INVENTORY.md",
];

const urlCapabilityPatterns = [
  /[?&]capability(?:=|\$\{|%3[dD])/,
  /searchParams\.(?:get|set|append)\([^\n]*capability/i,
];

test("production media transport cannot put capabilities in URLs", async () => {
  for (const source of productionSources) {
    const text = await readFile(source, "utf8");
    for (const pattern of urlCapabilityPatterns)
      assert.doesNotMatch(text, pattern);
  }
});

test("the transport guard detects URL-carried capability mutations", () => {
  assert.match("/media/asset?capability=${token}", urlCapabilityPatterns[0]);
  assert.match(
    'url.searchParams.set("capability", token)',
    urlCapabilityPatterns[1],
  );
});

test("production clients and API retain the header-only protocol anchors", async () => {
  const [api, browser, native] = await Promise.all([
    readFile("apps/api/src/routes/media-delivery.ts", "utf8"),
    readFile("apps/player/src/core/assets.ts", "utf8"),
    readFile(
      "apps/player/android/app/src/main/java/com/screengoblin/player/MediaCacheStore.java",
      "utf8",
    ),
  ]);
  for (const text of [api, browser, native]) {
    assert.match(text, /MediaCapability/);
    assert.match(text, /Authorization/);
  }
});

test("current documentation cannot regress to empty-body manifest GET", async () => {
  const stalePatterns = [
    /SHA-256:\s*empty bytes for manifest/i,
    /Manifest GET retries/i,
    /\|\s*GET\s*\|[^\n]*deviceApiBaseUrl[^\n]*manifest/i,
  ];
  for (const source of currentProtocolDocs) {
    const contents = await readFile(source, "utf8");
    for (const pattern of stalePatterns) assert.doesNotMatch(contents, pattern);
  }
  assert.match("Manifest GET retries", stalePatterns[1]);
  assert.match(
    "| GET | `{deviceApiBaseUrl}/manifest` | stale |",
    stalePatterns[2],
  );
});
