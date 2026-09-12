import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateStaticSecurityPolicy } from "./validate-static-security-policy.mjs";

const TODAY = "2026-09-12";

async function fixture(overrides = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "static-security-policy-"),
  );
  const values = {
    staticPolicy: { version: 1, exceptions: [] },
    licensePolicy: {
      version: 1,
      allowedLicenseExpressions: ["MIT"],
      exceptions: [],
    },
    lockfile: {
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture" },
        "node_modules/example": {
          version: "1.2.3",
          resolved: "https://registry.example.invalid/example.tgz",
          integrity: "sha512-QUFBQQ==",
          license: "MIT",
        },
      },
    },
    ...overrides,
  };
  const files = {
    staticPolicy: path.join(directory, "static.json"),
    licensePolicy: path.join(directory, "licenses.json"),
    lockfile: path.join(directory, "package-lock.json"),
    trivyIgnoreOutput: path.join(directory, "generated", "trivyignore.yaml"),
    licenseEvidenceOutput: path.join(directory, "evidence", "licenses.json"),
  };
  await Promise.all([
    writeFile(files.staticPolicy, JSON.stringify(values.staticPolicy)),
    writeFile(files.licensePolicy, JSON.stringify(values.licensePolicy)),
    writeFile(files.lockfile, JSON.stringify(values.lockfile)),
  ]);
  return { directory, files };
}

async function validate(files) {
  return validateStaticSecurityPolicy({ ...files, today: TODAY });
}

test("current repository policy covers the lockfile", async () => {
  const evidence = await validateStaticSecurityPolicy({
    staticPolicy: "security/static-scan-exceptions.json",
    licensePolicy: "security/dependency-license-policy.json",
    lockfile: "package-lock.json",
    today: TODAY,
  });
  assert.ok(evidence.dependencyCount > 490);
  assert.deepEqual(evidence.appliedExceptions, []);
});

test("evidence is deterministic, sanitized, and explicit", async (context) => {
  const { directory, files } = await fixture();
  context.after(() => rm(directory, { recursive: true, force: true }));

  const first = await validate(files);
  const firstText = await readFile(files.licenseEvidenceOutput, "utf8");
  await validate(files);
  assert.equal(await readFile(files.licenseEvidenceOutput, "utf8"), firstText);
  assert.equal(first.dependencyCount, 1);
  assert.match(
    await readFile(files.trivyIgnoreOutput, "utf8"),
    /Generated from/,
  );
  assert.doesNotMatch(firstText, /registry\.example|integrity|resolved/);
});

test("fails closed on an unknown license", async (context) => {
  const { directory, files } = await fixture({
    lockfile: {
      lockfileVersion: 3,
      packages: {
        "node_modules/example": {
          version: "1.2.3",
          resolved: "https://registry.example.invalid/example.tgz",
          license: "Unknown-Custom",
        },
      },
    },
  });
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(validate(files), /unapproved license Unknown-Custom/);
});

test("rejects broad and expired static exceptions", async (context) => {
  const broad = await fixture({
    staticPolicy: {
      version: 1,
      exceptions: [
        {
          scanner: "secret",
          id: "fixture-rule",
          paths: ["**/*"],
          statement: "Fixture justification is specific.",
          expiresOn: "2026-10-01",
        },
      ],
    },
  });
  context.after(() => rm(broad.directory, { recursive: true, force: true }));
  await assert.rejects(
    validate(broad.files),
    /literal repository-relative file path/,
  );

  const expired = await fixture({
    staticPolicy: {
      version: 1,
      exceptions: [
        {
          scanner: "misconfig",
          id: "AVD-TEST",
          paths: ["deploy/fixture.tf"],
          statement: "Fixture justification is specific.",
          expiresOn: "2026-09-11",
        },
      ],
    },
  });
  context.after(() => rm(expired.directory, { recursive: true, force: true }));
  await assert.rejects(validate(expired.files), /has expired/);
});

test("rejects stale license exceptions with no dependency", async (context) => {
  const { directory, files } = await fixture({
    licensePolicy: {
      version: 1,
      allowedLicenseExpressions: ["MIT"],
      exceptions: [
        {
          package: "missing-package",
          version: "1.0.0",
          licenseExpression: "Custom",
          statement: "Temporary review exception for fixture.",
          expiresOn: "2026-10-01",
        },
      ],
    },
  });
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(validate(files), /unused license exception/);
});

test("inventories an entry without resolved provenance", async (context) => {
  const unresolved = await fixture({
    lockfile: {
      lockfileVersion: 3,
      packages: {
        "node_modules/example": { version: "1.2.3", license: "MIT" },
      },
    },
  });
  context.after(() =>
    rm(unresolved.directory, { recursive: true, force: true }),
  );
  const evidence = await validate(unresolved.files);
  assert.equal(evidence.dependencyCount, 1);
  assert.equal(evidence.dependencies[0].provenanceKind, "lockfile-unresolved");
});

test("rejects missing version and license metadata", async (context) => {
  const cases = [
    {
      label: "version",
      entry: {
        resolved: "https://registry.example.invalid/example.tgz",
        integrity: "sha512-QUFBQQ==",
        license: "MIT",
      },
      error: /must have an exact version/,
    },
    {
      label: "license",
      entry: {
        version: "1.2.3",
        resolved: "https://registry.example.invalid/example.tgz",
        integrity: "sha512-QUFBQQ==",
      },
      error: /must have an exact license/,
    },
  ];

  for (const item of cases) {
    const current = await fixture({
      lockfile: {
        lockfileVersion: 3,
        packages: { "node_modules/example": item.entry },
      },
    });
    context.after(() =>
      rm(current.directory, { recursive: true, force: true }),
    );
    await assert.rejects(validate(current.files), item.error, item.label);
  }
});

test("file and git dependencies cannot bypass license policy", async (context) => {
  const fileDependency = await fixture({
    lockfile: {
      lockfileVersion: 3,
      packages: {
        "node_modules/local-external": {
          version: "2.0.0",
          resolved: "file:vendor/local-external.tgz",
          license: "Custom-File-License",
        },
      },
    },
  });
  context.after(() =>
    rm(fileDependency.directory, { recursive: true, force: true }),
  );
  await assert.rejects(
    validate(fileDependency.files),
    /unapproved license Custom-File-License/,
  );

  const gitDependency = await fixture({
    lockfile: {
      lockfileVersion: 3,
      packages: {
        "node_modules/git-external": {
          version: "3.0.0",
          resolved:
            "git+https://github.com/example/project.git#0123456789abcdef0123456789abcdef01234567",
          license: "MIT",
        },
      },
    },
  });
  context.after(() =>
    rm(gitDependency.directory, { recursive: true, force: true }),
  );
  const evidence = await validate(gitDependency.files);
  assert.equal(evidence.dependencies[0].provenanceKind, "git-commit");
  assert.doesNotMatch(
    await readFile(gitDependency.files.licenseEvidenceOutput, "utf8"),
    /github\.com|vendor\/local-external/,
  );
});

test("nested entries may inherit only exact package-version provenance", async (context) => {
  const inherited = await fixture({
    lockfile: {
      lockfileVersion: 3,
      packages: {
        "node_modules/example": {
          version: "1.2.3",
          resolved: "https://registry.example.invalid/example.tgz",
          integrity: "sha512-QUFBQQ==",
          license: "MIT",
        },
        "apps/player/node_modules/example": {
          version: "1.2.3",
          license: "MIT",
        },
      },
    },
  });
  context.after(() =>
    rm(inherited.directory, { recursive: true, force: true }),
  );
  const evidence = await validate(inherited.files);
  assert.equal(evidence.dependencyCount, 2);
  assert.equal(
    evidence.dependencies.find((entry) =>
      entry.provenanceKind.startsWith("inherited-"),
    )?.provenanceKind,
    "inherited-https-integrity",
  );
});
