import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { androidSdkCommandLineToolsVersion } from "./validate-android-release-surface.mjs";

async function createAnalyzer(root, revisionProperties) {
  const packageRoot = join(root, "cmdline-tools", "fixture");
  const analyzer = join(packageRoot, "bin", "apkanalyzer");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(analyzer, "#!/bin/sh\nexit 0\n");
  if (revisionProperties !== undefined)
    await writeFile(join(packageRoot, "source.properties"), revisionProperties);
  return { analyzer, packageRoot };
}

test("reads the bounded command-line tools revision beside the real analyzer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screengoblin-sdk-version-"));
  try {
    const { analyzer } = await createAnalyzer(
      join(directory, "real"),
      "Pkg.Revision=19.0\nPkg.Path=cmdline-tools;19.0\n",
    );
    const shimRoot = join(directory, "shim");
    const shim = join(shimRoot, "bin", "apkanalyzer");
    await mkdir(join(shimRoot, "bin"), { recursive: true });
    await writeFile(
      join(shimRoot, "source.properties"),
      "Pkg.Revision=999.0\n",
    );
    await symlink(analyzer, shim);

    assert.equal(
      androidSdkCommandLineToolsVersion(shim),
      "Android SDK Command-Line Tools 19.0",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing, malformed, duplicate, and oversized SDK revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screengoblin-sdk-version-"));
  try {
    const fixtures = [
      undefined,
      "Pkg.Revision=19.0-rc1\n",
      "Pkg.Revision=19.0\nPkg.Revision=20.0\n",
      `Pkg.Revision=19.0\n${"x".repeat(16 * 1024)}\n`,
    ];
    for (const [index, properties] of fixtures.entries()) {
      const { analyzer } = await createAnalyzer(
        join(directory, String(index)),
        properties,
      );
      assert.throws(
        () => androidSdkCommandLineToolsVersion(analyzer),
        /APK analyzer SDK metadata is unavailable or invalid/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "does not follow a substituted SDK metadata symlink",
  { skip: typeof constants.O_NOFOLLOW !== "number" },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "screengoblin-sdk-version-"),
    );
    try {
      const { analyzer, packageRoot } = await createAnalyzer(
        directory,
        undefined,
      );
      const substituted = join(directory, "substituted.properties");
      await writeFile(substituted, "Pkg.Revision=999.0\n");
      await symlink(substituted, join(packageRoot, "source.properties"));

      assert.throws(
        () => androidSdkCommandLineToolsVersion(analyzer),
        /APK analyzer SDK metadata is unavailable or invalid/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
