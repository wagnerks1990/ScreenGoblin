import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const composeUrl = new URL("docker-compose.yml", root);
const environmentUrl = new URL("deploy/.env.example", root);
const packageUrl = new URL("apps/api/package.json", root);
const commandUrl = new URL("apps/api/prisma/provision-member.ts", root);
const coreUrl = new URL("apps/api/src/identity/member-provisioning.ts", root);
const appUrl = new URL("apps/api/src/app.ts", root);
const serverUrl = new URL("apps/api/src/server.ts", root);
const routesUrl = new URL("apps/api/src/routes/", root);

const provisionVariables = [
  "MEMBER_PROVISION_ACKNOWLEDGEMENT",
  "MEMBER_PROVISION_ORGANIZATION_SLUG",
  "MEMBER_PROVISION_EMAIL",
  "MEMBER_PROVISION_NAME",
  "MEMBER_PROVISION_ROLE",
  "MEMBER_PROVISION_TEMPORARY_PASSWORD",
  "MEMBER_PROVISION_REASON",
];

const serviceSource = (compose, name, nextName) => {
  const match = compose.match(
    new RegExp(`^  ${name}:[\\s\\S]*?(?=\\n  ${nextName}:)`, "m"),
  );
  assert.ok(match, `missing ${name} service`);
  return match[0];
};

const readTypeScriptTree = async (directoryUrl) => {
  const sources = [];
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    const entryUrl = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directoryUrl,
    );
    if (entry.isDirectory()) {
      sources.push(...(await readTypeScriptTree(entryUrl)));
    } else if (entry.name.endsWith(".ts")) {
      sources.push([entryUrl.pathname, await readFile(entryUrl, "utf8")]);
    }
  }
  return sources;
};

test("Compose exposes a hardened offline-only member-provisioning job", async () => {
  const compose = await readFile(composeUrl, "utf8");
  const service = serviceSource(compose, "api-provision-member", "api");

  assert.match(service, /profiles: \[identity-admin\]/);
  assert.match(
    service,
    /command: \["npm", "run", "member:provision", "-w", "@screengoblin\/api"\]/,
  );
  assert.match(service, /restart: "no"/);
  assert.match(service, /user: "1000:1000"/);
  assert.match(service, /read_only: true/);
  assert.match(service, /\/tmp:size=16m,mode=0700,uid=1000,gid=1000/);
  assert.match(service, /no-new-privileges:true/);
  assert.match(service, /cap_drop: \[ALL\]/);
  assert.match(service, /HOME: \/tmp/);
  assert.match(service, /DATABASE_URL: \$\{DATABASE_URL:\?set DATABASE_URL\}/);
  assert.doesNotMatch(
    service,
    /MIGRATION_DATABASE_URL|POSTGRES_(?:USER|PASSWORD)/,
  );
  assert.match(
    service,
    /api-db-privileges:[\s\S]*service_completed_successfully/,
  );
  assert.match(service, /networks: \[backend\]/);
  assert.doesNotMatch(service, /^\s+(?:ports|expose|volumes|network_mode):/m);

  for (const variable of provisionVariables) {
    assert.match(service, new RegExp(`${variable}: \\$\\{${variable}:-\\}`));
  }
});

test("deployment template keeps provisioning inputs empty and ephemeral", async () => {
  const environment = await readFile(environmentUrl, "utf8");
  assert.match(
    environment,
    /Leave these values empty[\s\S]*clear them immediately/,
  );
  for (const variable of provisionVariables) {
    assert.match(environment, new RegExp(`^${variable}=$`, "m"));
    assert.equal(
      [...environment.matchAll(new RegExp(`^${variable}=`, "gm"))].length,
      1,
      `${variable} must have exactly one empty template entry`,
    );
  }
});

test("workspace script remains an offline command and never becomes an HTTP surface", async () => {
  const [
    packageSource,
    commandSource,
    coreSource,
    appSource,
    serverSource,
    routeSources,
  ] = await Promise.all([
    readFile(packageUrl, "utf8"),
    readFile(commandUrl, "utf8"),
    readFile(coreUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(serverUrl, "utf8"),
    readTypeScriptTree(routesUrl),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts["member:provision"],
    "tsx prisma/provision-member.ts",
  );
  for (const variable of provisionVariables) {
    assert.match(commandSource, new RegExp(`\\b${variable}\\b`));
  }
  const offlineSources = `${commandSource}\n${coreSource}`;
  assert.match(
    offlineSources,
    /CREATE_NEW_NON_OWNER_MEMBER_WITH_24_HOUR_ROTATION/,
  );
  assert.match(offlineSources, /identity\.member_provisioned/);
  assert.match(offlineSources, /auth\.bootstrap_password_containment_enabled/);
  const outputCalls = [
    ...commandSource.matchAll(
      /console\.(?:log|info|warn|error)\s*\(([\s\S]*?)\n\s*\);/g,
    ),
  ];
  assert.equal(
    outputCalls.length,
    1,
    "CLI must retain one reviewed output call",
  );
  const outputExpression = outputCalls[0][1];
  assert.deepEqual(
    [
      ...new Set(
        [...outputExpression.matchAll(/result\.([A-Za-z]+)/g)].map(
          (match) => match[1],
        ),
      ),
    ].sort(),
    [
      "changeBefore",
      "membershipId",
      "normalizedEmail",
      "organizationId",
      "role",
      "status",
      "userId",
    ],
  );
  assert.doesNotMatch(outputExpression, /input|process\.env|password|hash/i);

  for (const [path, source] of [
    [appUrl.pathname, appSource],
    [serverUrl.pathname, serverSource],
    ...routeSources,
  ]) {
    assert.doesNotMatch(
      source,
      /MEMBER_PROVISION_|member:provision|provision-member/,
      `offline provisioning leaked into API runtime source: ${join(path)}`,
    );
  }
});
