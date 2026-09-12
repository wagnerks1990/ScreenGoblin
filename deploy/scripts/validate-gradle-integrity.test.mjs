import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateGradleIntegrity } from "./validate-gradle-integrity.mjs";

const checksum = "a".repeat(64);
const securedBuildTools = [
  "com.android.tools.build:gradle:8.10.1",
  "io.netty:netty-buffer:4.1.137.Final",
  "io.netty:netty-codec:4.1.137.Final",
  "io.netty:netty-codec-http:4.1.137.Final",
  "io.netty:netty-codec-http2:4.1.137.Final",
  "io.netty:netty-codec-socks:4.1.137.Final",
  "io.netty:netty-common:4.1.137.Final",
  "io.netty:netty-handler:4.1.137.Final",
  "io.netty:netty-handler-proxy:4.1.137.Final",
  "io.netty:netty-resolver:4.1.137.Final",
  "io.netty:netty-transport:4.1.137.Final",
  "io.netty:netty-transport-native-unix-common:4.1.137.Final",
  "com.google.protobuf:protobuf-java:3.25.5",
  "com.google.protobuf:protobuf-java-util:3.25.5",
  "com.google.protobuf:protobuf-kotlin:3.25.5",
  "org.bitbucket.b_c:jose4j:0.9.6",
  "org.bouncycastle:bcpkix-jdk18on:1.84",
  "org.bouncycastle:bcprov-jdk18on:1.84",
  "org.bouncycastle:bcutil-jdk18on:1.84",
  "org.jdom:jdom2:2.0.6.1",
];
const forcedBuildTools = securedBuildTools
  .map((coordinate) => `'${coordinate}'`)
  .join(",\n      ");
const rootForcedBuildTools = securedBuildTools
  .slice(1)
  .map((coordinate) => `'${coordinate}'`)
  .join(",\n      ");
const lockfile = `# This is a Gradle generated file for dependency locking.
# Manual edits can break the build and are not advised.
# This file is expected to be part of source control.
org.example:example:1.2.3=classpath
empty=
`;
const buildFile = `buildscript {
  configurations.classpath {
    resolutionStrategy.force(
      ${rootForcedBuildTools}
    )
    resolutionStrategy.activateDependencyLocking()
  }
  dependencies {
    classpath 'com.android.tools.build:gradle:8.10.1'
  }
}
allprojects {
  if (project != rootProject) {
    def buildscriptLockName = project.path.substring(1).replace(':', '-')
    buildscript {
      configurations.classpath {
        resolutionStrategy.force(
          ${forcedBuildTools}
        )
        resolutionStrategy.activateDependencyLocking()
      }
      dependencyLocking {
        lockMode = LockMode.STRICT
        lockFile = rootProject.file("gradle/dependency-locks/\${buildscriptLockName}-buildscript.lockfile")
      }
    }
  }
  dependencyLocking {
    lockAllConfigurations()
    lockMode = LockMode.STRICT
    def lockName = project.path == ':' ? 'root' : project.path
    lockFile = rootProject.file("gradle/dependency-locks/\${lockName}.lockfile")
  }
  configurations.configureEach {
    resolutionStrategy.force(
      ${rootForcedBuildTools}
    )
  }
}
`;
const wrapperJar = readFileSync(
  new URL(
    "../../apps/player/android/gradle/wrapper/gradle-wrapper.jar",
    import.meta.url,
  ),
);

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
    "apps/player/android/build.gradle": buildFile,
    "apps/player/android/buildscript-gradle.lockfile": lockfile,
    "apps/player/android/gradle/dependency-locks/app-buildscript.lockfile":
      lockfile
        .replace("org.example:example:1.2.3=classpath\n", "")
        .replace("empty=", "empty=classpath"),
    "apps/player/android/gradle/dependency-locks/app.lockfile": lockfile,
    "apps/player/android/gradle/dependency-locks/capacitor-android-buildscript.lockfile":
      lockfile,
    "apps/player/android/gradle/dependency-locks/capacitor-android.lockfile":
      lockfile,
    "apps/player/android/gradle/dependency-locks/capacitor-cordova-android-plugins-buildscript.lockfile":
      lockfile,
    "apps/player/android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile":
      lockfile,
    "apps/player/android/gradle/wrapper/gradle-wrapper.properties":
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-all.zip\ndistributionSha256Sum=89d4e70e4e84e2d2dfbb63e4daa53e21b25017cc70c37e4eea31ee51fb15098a\nvalidateDistributionUrl=true\n",
    "apps/player/android/gradle/wrapper/gradle-wrapper.jar": wrapperJar,
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

test("rejects missing, extra, malformed, duplicate, and dynamic lock entries", () => {
  const root = fixture();
  rmSync(
    join(
      root,
      "apps/player/android/gradle/dependency-locks/capacitor-android.lockfile",
    ),
  );
  writeFileSync(
    join(root, "apps/player/android/gradle/dependency-locks/app.lockfile"),
    `${lockfile.replace("1.2.3", "1.+")}org.example:example:1.+=runtimeClasspath\ninvalid\n`,
  );
  writeFileSync(
    join(
      root,
      "apps/player/android/gradle/dependency-locks/unexpected.lockfile",
    ),
    lockfile,
  );
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /capacitor-android\.lockfile: required/);
  assert.match(errors, /unexpected\.lockfile: unexpected/);
  assert.match(errors, /duplicate locked module/);
  assert.match(errors, /non-exact version selector/);
  assert.match(errors, /lock entry must be exact/);
});

test("rejects incomplete lockfiles and missing lock enforcement", () => {
  const root = fixture();
  writeFileSync(
    join(root, "apps/player/android/build.gradle"),
    "allprojects {}\n",
  );
  writeFileSync(
    join(root, "apps/player/android/buildscript-gradle.lockfile"),
    "# not generated\nempty=bad config\n",
  );
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /Gradle-generated dependency-lock header is missing/);
  assert.match(errors, /malformed Gradle empty configuration marker/);
  assert.match(errors, /at least one locked module is required/);
  assert.match(errors, /missing buildscript dependency locking activation/);
  assert.match(errors, /missing lockAllConfigurations/);
  assert.match(errors, /missing LockMode\.STRICT/);
  assert.match(errors, /missing custom checked-in dependency lock path/);
  assert.match(errors, /must secure root, generated buildscript, and project/);
});

test("rejects vulnerable Android build-tool version drift", () => {
  const root = fixture();
  writeFileSync(
    join(root, "apps/player/android/build.gradle"),
    buildFile.replaceAll("4.1.137.Final", "4.1.110.Final"),
  );
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /netty-buffer:4\.1\.137\.Final must secure/);
});

test("rejects vulnerable versions selected by any dependency lock", () => {
  const root = fixture();
  const path = join(
    root,
    "apps/player/android/gradle/dependency-locks/app.lockfile",
  );
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "empty=",
      "io.netty:netty-common:4.1.110.Final=testRuntimeClasspath\nempty=",
    ),
  );
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /netty-common must resolve to secured version/);
});

test("rejects dependency-locking bypasses and lock mutation commands", () => {
  const root = fixture();
  writeFileSync(
    join(root, "apps/player/android/app.gradle"),
    "dependencyLocking { ignoredDependencies.add('x:y'); deactivateDependencyLocking(); unlock() }\n",
  );
  writeFileSync(
    join(root, ".github/workflows/lock-update.yml"),
    "steps:\n  - run: ./gradlew --write-locks\n",
  );
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /dependency locking bypass is forbidden/);
  assert.match(errors, /dependency lock mutation flag is forbidden/);
});

test("rejects wrapper property or JAR drift", () => {
  const root = fixture();
  writeFileSync(
    join(root, "apps/player/android/gradle/wrapper/gradle-wrapper.properties"),
    "distributionUrl=https\\://example.invalid/gradle.zip\n",
  );
  writeFileSync(
    join(root, "apps/player/android/gradle/wrapper/gradle-wrapper.jar"),
    "tampered",
  );
  const errors = validateGradleIntegrity(root).join("\n");
  assert.match(errors, /distributionUrl must be set exactly once/);
  assert.match(errors, /distributionSha256Sum must be set exactly once/);
  assert.match(errors, /validateDistributionUrl must be set exactly once/);
  assert.match(errors, /SHA-256 does not match/);
});
