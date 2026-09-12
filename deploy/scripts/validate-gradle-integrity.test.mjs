import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateGradleIntegrity } from "./validate-gradle-integrity.mjs";

const checksum = "a".repeat(64);

function fixture({
  metadata,
  properties,
  command = "./gradlew --dependency-verification=strict test",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gradle-integrity-"));
  const files = {
    "apps/player/android/gradle/verification-metadata.xml":
      metadata ??
      `<verification-metadata><configuration><verify-metadata>true</verify-metadata><verify-signatures>false</verify-signatures></configuration><components><sha256 value="${checksum}"/></components></verification-metadata>`,
    "apps/player/android/gradle.properties":
      properties ??
      "org.gradle.dependency.verification=strict\norg.gradle.dependency.verification.console=verbose\n",
    ".github/workflows/ci.yml": `steps:\n  - run: ${command}\n`,
    ".github/workflows/codeql.yml": `steps:\n  - run: ${command}\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  return root;
}

test("accepts strict Gradle integrity configuration", () => {
  assert.deepEqual(validateGradleIntegrity(fixture()), []);
});

test("rejects malformed, exempted, and invalid-checksum metadata", () => {
  const root = fixture({
    metadata:
      '<verification-metadata><configuration><verify-metadata>true</verify-metadata><verify-signatures>false</verify-signatures><trusted-artifacts/></configuration><sha256 value="ABC"/></verification-metadata>',
  });
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /trust\/ignore exemptions are forbidden/);
  assert.match(errors, /64 lowercase hexadecimal/);
});

test("rejects missing strict properties and lenient bypasses", () => {
  const root = fixture({
    properties:
      "org.gradle.dependency.verification=lenient\norg.gradle.dependency.verification.console=quiet\n",
  });
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /must be set exactly once to strict/);
  assert.match(errors, /must be set exactly once to verbose/);
  assert.match(errors, /dependency verification bypass is forbidden/);
});

test("rejects Gradle workflow commands without an explicit strict flag", () => {
  const errors = validateGradleIntegrity(
    fixture({ command: "./gradlew test" }),
  ).join("\n");
  assert.match(errors, /ci\.yml:2: Gradle command must explicitly use/);
  assert.match(errors, /codeql\.yml:2: Gradle command must explicitly use/);
});

test("rejects removing the required Gradle workflow command", () => {
  const errors = validateGradleIntegrity(
    fixture({ command: "echo skipped" }),
  ).join("\n");
  assert.match(errors, /ci\.yml: required Gradle command is missing/);
  assert.match(errors, /codeql\.yml: required Gradle command is missing/);
});

test("rejects malformed XML", () => {
  const errors = validateGradleIntegrity(
    fixture({
      metadata:
        "<verification-metadata><configuration></verification-metadata>",
    }),
  ).join("\n");
  assert.match(errors, /malformed XML/);
});

test("rejects missing verification metadata without a check/read race", () => {
  const root = fixture();
  rmSync(join(root, "apps/player/android/gradle/verification-metadata.xml"));
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /verification metadata is missing/);
});
