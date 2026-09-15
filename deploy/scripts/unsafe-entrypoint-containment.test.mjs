import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

async function sourceFiles(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(relativeDirectory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(relative)
        : /\.(?:ts|tsx|js|mjs)$/.test(entry.name)
          ? [relative]
          : [];
    }),
  );
  return nested.flat();
}

test("legacy roles cannot acquire emergency activation or clear authority", async () => {
  const policy = await read("apps/api/src/authorization/policy.ts");
  const roleBundle = policy.match(
    /const ROLE_CAPABILITIES = ([\s\S]*?) satisfies Record/,
  )?.[1];
  assert.ok(
    roleBundle,
    "role capability bundle must remain statically reviewable",
  );
  assert.doesNotMatch(roleBundle, /emergencyActivate|emergencyClear/);
});

test("caller-supplied media ingestion entrypoints remain absent", async () => {
  const routes = await sourceFiles("apps/api/src/routes");
  const routeSource = (
    await Promise.all(
      routes.map(async (file) => `${file}\n${await read(file)}`),
    )
  ).join("\n");
  assert.doesNotMatch(
    routeSource,
    /\.(?:post|put|patch)\(\s*["'`]\/media(?:[\/"'`])/,
  );
  assert.doesNotMatch(
    routeSource,
    /media-ingestions|multipart|createMediaAndAudit/,
  );
  assert.doesNotMatch(routeSource, /fetch\s*\(/);

  const mediaRoute = await read("apps/api/src/routes/media.ts");
  assert.doesNotMatch(
    mediaRoute,
    /new URL|fetch\s*\(|media-url|media-policy|SUPPORTED_MEDIA_MIME_TYPES/,
  );

  const packageManifest = JSON.parse(await read("apps/api/package.json"));
  const dependencies = {
    ...packageManifest.dependencies,
    ...packageManifest.devDependencies,
  };
  for (const parser of [
    "@fastify/multipart",
    "fastify-multipart",
    "busboy",
    "formidable",
    "multer",
  ])
    assert.equal(
      dependencies[parser],
      undefined,
      `${parser} must remain absent`,
    );
});

test("removed legacy registration configuration cannot be restored silently", async () => {
  const files = [
    "apps/api/src/app.ts",
    "apps/api/src/config.ts",
    "apps/api/src/server.ts",
    "apps/api/src/types.d.ts",
    "apps/api/.env.example",
    "deploy/.env.example",
    "docker-compose.yml",
  ];
  const environmentSwitch = ["LEGACY", "MEDIA", "REGISTRATION", "ENABLED"].join(
    "_",
  );
  const applicationSwitch = ["legacy", "Media", "Registration", "Enabled"].join(
    "",
  );
  for (const file of files)
    assert.ok(
      !(await read(file)).includes(environmentSwitch) &&
        !(await read(file)).includes(applicationSwitch),
      `${file} must not restore the removed registration switch`,
    );
});
