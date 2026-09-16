import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateAndroidReleaseManifest } from "./validate-android-release-surface.mjs";

const fixture = await readFile(
  new URL("./fixtures/android-release-manifest.xml", import.meta.url),
  "utf8",
);

test("XML comments cannot reconstruct allowlisted manifest syntax", () => {
  const mutations = [
    fixture.replace("android:allowBackup", "android:allowBack<!-- split -->up"),
    fixture.replace("<application", "<app<!-- split -->lication"),
    fixture.replace("<application", "<!-- comment --><application"),
  ];

  for (const mutation of mutations) {
    assert.notEqual(mutation, fixture);
    assert.throws(
      () => validateAndroidReleaseManifest(mutation),
      /XML comments are forbidden/,
    );
  }
});
