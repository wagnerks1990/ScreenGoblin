import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const javaRoot = join(
  repositoryRoot,
  "apps/player/android/app/src/main/java/com/screengoblin/player",
);
const mainActivityPath = join(javaRoot, "MainActivity.java");
const pluginPath = join(javaRoot, "DeviceCommandJournalPlugin.java");
const journalPath = join(javaRoot, "DeviceCommandJournal.java");
const forbiddenSurface =
  /\b(?:DeviceCommandJournalPlugin|REFRESH_CONTENT|RESTART_RENDERER)\b/;
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const nativeSourceExtensions = new Set([
  ".gradle",
  ".java",
  ".json",
  ".kt",
  ".kts",
  ".xml",
]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && sourceExtensions.has(extname(entry.name))
      ? [path]
      : [];
  });
}

function filesWithExtensions(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesWithExtensions(path, extensions);
    return entry.isFile() && extensions.has(extname(entry.name)) ? [path] : [];
  });
}

test("staged device-command journal remains unreachable from Capacitor, player JS, contracts, and server", () => {
  const plugin = readFileSync(pluginPath, "utf8");
  assert.match(
    plugin,
    /@CapacitorPlugin\(name = "DeviceCommandJournal"\)/,
    "the staged native implementation must remain explicit",
  );
  assert.doesNotMatch(
    plugin,
    /recoverRestartCompletion|void load\s*\(/,
    "plugin construction or reload must not report a renderer restart as successful",
  );
  assert.match(
    plugin,
    /restartActivity = requireRendererActivity\(\)[\s\S]*journal\(\)\.accept/,
    "a missing Activity must be rejected before a restart is durably accepted",
  );
  assert.match(
    plugin,
    /Activity requireRendererActivity\(\)[\s\S]*if \(activity == null\)[\s\S]*RENDERER_UNAVAILABLE/,
    "renderer transitions must fail closed when no Activity is attached",
  );
  assert.ok(
    plugin.indexOf("activity.runOnUiThread") <
      plugin.indexOf("call.resolve(result(accepted))"),
    "restart scheduling must happen before acceptance is reported",
  );
  assert.doesNotMatch(
    plugin,
    /@PluginMethod[\s\S]{0,120}confirmRendererReady\s*\(/,
    "renderer readiness must never be asserted by bridge JavaScript",
  );
  assert.match(
    plugin,
    /\n\s{4}DeviceCommandJournal\.Result confirmRendererReady\s*\(/,
    "restart completion must remain a package-private native lifecycle hook",
  );
  assert.match(
    readFileSync(journalPath, "utf8"),
    /confirmRendererRestarted[\s\S]*LIFECYCLE_NOT_ADVANCED/,
    "the native readiness hook must require a different renderer lifecycle",
  );

  const mainActivity = readFileSync(mainActivityPath, "utf8");
  assert.doesNotMatch(
    mainActivity,
    /\bDeviceCommandJournalPlugin\b/,
    "MainActivity must not register the staged journal before authenticated command delivery exists",
  );
  const manifest = readFileSync(
    join(
      repositoryRoot,
      "apps/player/android/app/src/main/AndroidManifest.xml",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    manifest,
    /android:process\s*=/,
    "the in-process journal lock requires the Player to remain single-process",
  );

  for (const directory of [
    "apps/player/src",
    "packages/contracts/src",
    "apps/api/src",
  ]) {
    for (const path of sourceFiles(join(repositoryRoot, directory))) {
      assert.doesNotMatch(
        readFileSync(path, "utf8"),
        forbiddenSurface,
        `${relative(repositoryRoot, path)} must not expose the staged native command surface`,
      );
    }
  }

  const stagedNativeFiles = new Set([pluginPath, journalPath]);
  for (const path of filesWithExtensions(
    join(repositoryRoot, "apps/player/android/app/src/main"),
    nativeSourceExtensions,
  )) {
    if (stagedNativeFiles.has(path)) continue;
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      forbiddenSurface,
      `${relative(repositoryRoot, path)} must not register or invoke the staged native command surface`,
    );
  }
});
