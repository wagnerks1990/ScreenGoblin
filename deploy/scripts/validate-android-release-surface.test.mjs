import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createAndroidReleaseSurfaceReport,
  validateAndroidReleaseManifest,
} from "./validate-android-release-surface.mjs";

const fixtureUrl = new URL(
  "./fixtures/android-release-manifest.xml",
  import.meta.url,
);
const fixture = await readFile(fixtureUrl, "utf8");

test("accepts the exact packaged Android release surface", () => {
  assert.deepEqual(validateAndroidReleaseManifest(fixture), {
    schemaVersion: 1,
    package: "com.screengoblin.player",
    minSdkVersion: 23,
    targetSdkVersion: 35,
    permissions: [
      "android.permission.INTERNET",
      "android.permission.RECEIVE_BOOT_COMPLETED",
    ],
    features: ["android.hardware.touchscreen", "android.software.leanback"],
    exportedComponents: ["com.screengoblin.player.MainActivity"],
    nonExportedComponents: ["com.screengoblin.player.BootReceiver"],
    manifestSha256: createHash("sha256").update(fixture).digest("hex"),
  });
});

test("binds the policy report to the inspected APK bytes", () => {
  const apkBytes = Buffer.from("deterministic test APK bytes");
  assert.deepEqual(createAndroidReleaseSurfaceReport(fixture, apkBytes), {
    ...validateAndroidReleaseManifest(fixture),
    apkSha256: createHash("sha256").update(apkBytes).digest("hex"),
  });
  assert.throws(() =>
    createAndroidReleaseSurfaceReport(fixture, Buffer.alloc(0)),
  );
});

const mutations = [
  [
    "backup",
    (xml) =>
      xml.replace('android:allowBackup="false"', 'android:allowBackup="true"'),
  ],
  [
    "debuggable",
    (xml) =>
      xml.replace('android:debuggable="false"', 'android:debuggable="true"'),
  ],
  [
    "test-only",
    (xml) => xml.replace('android:testOnly="false"', 'android:testOnly="true"'),
  ],
  [
    "cleartext",
    (xml) =>
      xml.replace(
        'android:usesCleartextTraffic="false"',
        'android:usesCleartextTraffic="true"',
      ),
  ],
  [
    "camera permission",
    (xml) =>
      xml.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />',
      ),
  ],
  [
    "exported dependency service",
    (xml) =>
      xml.replace(
        "</application>",
        '    <service android:name="example.DependencyService" android:exported="true" />\n    </application>',
      ),
  ],
  [
    "broad file provider",
    (xml) =>
      xml.replace(
        "</application>",
        '    <provider android:name="androidx.core.content.FileProvider" android:authorities="com.screengoblin.player.fileprovider" android:exported="false" android:grantUriPermissions="true" />\n    </application>',
      ),
  ],
  [
    "package visibility query",
    (xml) =>
      xml.replace(
        "    <application",
        '    <queries><package android:name="example.other" /></queries>\n    <application',
      ),
  ],
  [
    "network security override",
    (xml) =>
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:networkSecurityConfig="@xml/network_security_config"',
      ),
  ],
  [
    "shared Android user",
    (xml) =>
      xml.replace(
        'package="com.screengoblin.player"',
        'package="com.screengoblin.player" android:sharedUserId="android.uid.system"',
      ),
  ],
  [
    "unexpected boot action",
    (xml) =>
      xml.replace(
        "android.intent.action.BOOT_COMPLETED",
        "android.intent.action.PACKAGE_REPLACED",
      ),
  ],
];

for (const [name, mutate] of mutations) {
  test(`rejects ${name}`, () => {
    const mutated = mutate(fixture);
    assert.notEqual(mutated, fixture);
    assert.throws(() => validateAndroidReleaseManifest(mutated));
  });
}

test("rejects XML entities and malformed duplicate attributes", () => {
  assert.throws(() =>
    validateAndroidReleaseManifest(
      `<!DOCTYPE manifest [<!ENTITY x "y">]>${fixture}`,
    ),
  );
  assert.throws(() =>
    validateAndroidReleaseManifest(
      fixture.replace(
        'package="com.screengoblin.player"',
        'package="com.screengoblin.player" package="com.screengoblin.player"',
      ),
    ),
  );
});

test("CI validates and retains the exact release APK evidence", async () => {
  const [workflow, sourceManifest] = await Promise.all([
    readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../apps/player/android/app/src/main/AndroidManifest.xml",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const build = workflow.indexOf("assembleDebug assembleRelease");
  const extract = workflow.indexOf('"$analyzer" manifest print');
  const validate = workflow.indexOf(
    "node ../../../deploy/scripts/validate-android-release-surface.mjs",
  );
  const upload = workflow.indexOf(
    "name: player-release-surface-${{ github.sha }}",
  );
  assert.ok(
    build >= 0 && build < extract && extract < validate && validate < upload,
  );
  assert.match(
    workflow,
    /validate-android-release-surface\.mjs \\\n+\s+android-release-surface\/AndroidManifest\.xml \\\n+\s+app\/build\/outputs\/apk\/release\/app-release-unsigned\.apk \\\n+\s+android-release-surface\/report\.json/,
  );
  assert.match(
    workflow,
    /apps\/player\/android\/app\/build\/outputs\/apk\/release\/app-release-unsigned\.apk/,
  );
  assert.match(workflow, /android-release-surface\/AndroidManifest\.xml/);
  assert.match(workflow, /android-release-surface\/report\.json/);
  assert.doesNotMatch(sourceManifest, /FileProvider|file_paths|<provider\b/);
});
