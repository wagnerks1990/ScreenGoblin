import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAndroidReleaseSurfaceReport,
  extractAndroidReleaseManifest,
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
      "com.screengoblin.player.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
    ],
    features: ["android.hardware.touchscreen", "android.software.leanback"],
    exportedComponents: ["com.screengoblin.player.MainActivity"],
    nonExportedComponents: [
      "com.screengoblin.player.BootReceiver",
      "androidx.startup.InitializationProvider",
    ],
    manifestSha256: createHash("sha256").update(fixture).digest("hex"),
  });
});

test("binds the policy report to the inspected APK bytes", () => {
  const apkBytes = Buffer.from("deterministic test APK bytes");
  assert.deepEqual(createAndroidReleaseSurfaceReport(fixture, apkBytes), {
    ...validateAndroidReleaseManifest(fixture),
    apkSha256: createHash("sha256").update(apkBytes).digest("hex"),
    analyzerVersion: "test",
  });
  assert.throws(() =>
    createAndroidReleaseSurfaceReport(fixture, Buffer.alloc(0)),
  );
});

test("extracts the exact manifest from the inspected APK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screengoblin-apkanalyzer-"));
  const commandLineTools = join(directory, "cmdline-tools", "fixture");
  const analyzer = join(commandLineTools, "bin", "apkanalyzer");
  const apk = join(directory, "release.apk");
  try {
    await mkdir(join(commandLineTools, "bin"), { recursive: true });
    await writeFile(
      join(commandLineTools, "source.properties"),
      "Pkg.Revision=19.0\nPkg.Path=cmdline-tools;19.0\n",
    );
    await writeFile(
      analyzer,
      `#!/bin/sh
if [ "$1" = "manifest" ] && [ "$2" = "print" ] && [ "$3" = "${apk}" ]; then
  cat '${fixtureUrl.pathname}'
else
  exit 64
fi
`,
    );
    await chmod(analyzer, 0o700);
    await writeFile(apk, "fixture APK bytes");
    assert.deepEqual(extractAndroidReleaseManifest(analyzer, apk), {
      analyzerVersion: "Android SDK Command-Line Tools 19.0",
      xml: fixture,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:debuggable="true"',
      ),
  ],
  [
    "test-only",
    (xml) =>
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:testOnly="true"',
      ),
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
    "permission max SDK",
    (xml) =>
      xml.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" android:maxSdkVersion="34" />',
      ),
  ],
  [
    "nearby signature protection level",
    (xml) =>
      xml.replace(
        'android:protectionLevel="0x2"',
        'android:protectionLevel="0x3"',
      ),
  ],
  [
    "uses-sdk max SDK",
    (xml) =>
      xml.replace(
        'android:targetSdkVersion="35"',
        'android:targetSdkVersion="35" android:maxSdkVersion="35"',
      ),
  ],
  [
    "disabled application",
    (xml) =>
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:enabled="false"',
      ),
  ],
  [
    "permission-guarded application",
    (xml) =>
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:permission="android.permission.INTERNET"',
      ),
  ],
  [
    "backup agent",
    (xml) =>
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:backupAgent="example.BackupAgent"',
      ),
  ],
  [
    "full backup content",
    (xml) =>
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:fullBackupContent="@xml/backup_rules"',
      ),
  ],
  [
    "data extraction rules",
    (xml) =>
      xml.replace(
        'android:allowBackup="false"',
        'android:allowBackup="false" android:dataExtractionRules="@xml/data_extraction_rules"',
      ),
  ],
  [
    "enabled launcher activity",
    (xml) =>
      xml.replace(
        'android:name="com.screengoblin.player.MainActivity"',
        'android:name="com.screengoblin.player.MainActivity" android:enabled="true"',
      ),
  ],
  [
    "nearby launcher config bitmask",
    (xml) =>
      xml.replace(
        'android:configChanges="0xff4"',
        'android:configChanges="0xff5"',
      ),
  ],
  [
    "nearby launcher mode",
    (xml) => xml.replace('android:launchMode="2"', 'android:launchMode="3"'),
  ],
  [
    "source-form resource reference",
    (xml) =>
      xml.replace(
        'android:banner="@ref/0x7f070074"',
        'android:banner="@drawable/tv_banner"',
      ),
  ],
  [
    "permission-guarded launcher activity",
    (xml) =>
      xml.replace(
        'android:name="com.screengoblin.player.MainActivity"',
        'android:name="com.screengoblin.player.MainActivity" android:permission="android.permission.INTERNET"',
      ),
  ],
  [
    "separate launcher process",
    (xml) =>
      xml.replace(
        'android:name="com.screengoblin.player.MainActivity"',
        'android:name="com.screengoblin.player.MainActivity" android:process=":remote"',
      ),
  ],
  [
    "direct-boot-aware receiver",
    (xml) =>
      xml.replace(
        'android:name="com.screengoblin.player.BootReceiver"',
        'android:name="com.screengoblin.player.BootReceiver" android:directBootAware="true"',
      ),
  ],
  [
    "permission-guarded receiver",
    (xml) =>
      xml.replace(
        'android:name="com.screengoblin.player.BootReceiver"',
        'android:name="com.screengoblin.player.BootReceiver" android:permission="android.permission.INTERNET"',
      ),
  ],
  [
    "separate receiver process",
    (xml) =>
      xml.replace(
        'android:name="com.screengoblin.player.BootReceiver"',
        'android:name="com.screengoblin.player.BootReceiver" android:process=":receiver"',
      ),
  ],
  [
    "intent filter priority",
    (xml) =>
      xml.replace("<intent-filter>", '<intent-filter android:priority="1">'),
  ],
  [
    "intent action attribute",
    (xml) =>
      xml.replace(
        '<action android:name="android.intent.action.MAIN" />',
        '<action android:name="android.intent.action.MAIN" android:priority="1" />',
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
  const [workflow, sourceManifest, appBuild, rootBuild, gradleProperties] =
    await Promise.all([
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
      readFile(
        new URL("../../apps/player/android/app/build.gradle", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../apps/player/android/build.gradle", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../apps/player/android/gradle.properties", import.meta.url),
        "utf8",
      ),
    ]);
  const build = workflow.indexOf("assembleDebug assembleRelease");
  const validate = workflow.indexOf(
    "node ../../../deploy/scripts/validate-android-release-surface.mjs",
  );
  const upload = workflow.indexOf(
    "name: player-release-surface-${{ github.sha }}",
  );
  assert.ok(build >= 0 && build < validate && validate < upload);
  assert.match(
    workflow,
    /validate-android-release-surface\.mjs \\\n+\s+"\$analyzer" \\\n+\s+app\/build\/outputs\/apk\/release\/app-release-unsigned\.apk \\\n+\s+android-release-surface\/AndroidManifest\.xml \\\n+\s+android-release-surface\/report\.json/,
  );
  assert.match(
    workflow,
    /apps\/player\/android\/app\/build\/outputs\/apk\/release\/app-release-unsigned\.apk/,
  );
  assert.match(workflow, /android-release-surface\/AndroidManifest\.xml/);
  assert.match(workflow, /android-release-surface\/report\.json/);
  assert.match(
    workflow,
    /name: player-release-surface-diagnostic-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 1/,
  );
  assert.doesNotMatch(sourceManifest, /FileProvider|file_paths/);
  assert.match(
    sourceManifest,
    /<uses-permission\b[^>]*android:name="android\.permission\.DUMP"[^>]*tools:ignore="ProtectedPermissions"[^>]*tools:node="remove"[^>]*\/>/,
  );
  assert.equal(
    sourceManifest.match(/tools:ignore="ProtectedPermissions"/g)?.length,
    1,
  );
  assert.match(
    sourceManifest,
    /<meta-data\b[^>]*android:name="androidx\.profileinstaller\.ProfileInstallerInitializer"[^>]*tools:ignore="MissingClass"[^>]*tools:node="remove"[^>]*\/>/,
  );
  assert.match(
    sourceManifest,
    /<receiver\b[^>]*android:name="androidx\.profileinstaller\.ProfileInstallReceiver"[^>]*tools:ignore="MissingClass"[^>]*tools:node="remove"[^>]*\/>/,
  );
  assert.match(
    sourceManifest,
    /<provider\b[^>]*android:name="androidx\.startup\.InitializationProvider"[^>]*tools:ignore="MissingClass"[^>]*tools:node="merge"[^>]*>/,
  );
  assert.equal(sourceManifest.match(/tools:ignore="MissingClass"/g)?.length, 3);
  assert.doesNotMatch(
    [workflow, appBuild, rootBuild, gradleProperties].join("\n"),
    /MissingClass|ProtectedPermissions/,
  );
});
