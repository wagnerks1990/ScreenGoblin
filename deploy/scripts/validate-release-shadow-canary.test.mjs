import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("candidate-create shadow evidence remains bounded and non-authoritative", async () => {
  const [store, shadow, schema] = await Promise.all([
    readFile(new URL("apps/api/src/store/prisma.ts", root), "utf8"),
    readFile(new URL("apps/api/src/authorization/shadow.ts", root), "utf8"),
    readFile(new URL("apps/api/prisma/schema.prisma", root), "utf8"),
  ]);

  assert.match(store, /SAVEPOINT release_authorization_shadow/);
  assert.match(store, /ROLLBACK TO SAVEPOINT release_authorization_shadow/);
  assert.equal(store.match(/FOR SHARE OF [^`]+ NOWAIT/g)?.length, 3);
  assert.match(store, /set_config\('statement_timeout', '250ms', true\)/);
  assert.match(
    store,
    /set_config\('statement_timeout', \$\{timeoutSetting\.statementTimeout\}, true\)/,
  );
  assert.match(store, /RELEASE_SHADOW_MAX_GRANTS \+ 1/);
  assert.match(store, /RELEASE_SHADOW_MAX_GROUP_EDGES \+ 1/);
  assert.match(
    store,
    /subjectMembershipId" = \$\{input\.actor\.membershipId\}/,
  );
  assert.match(store, /authorizationShadow,/);
  assert.doesNotMatch(store, /if\s*\([^)]*scopedAllowed/);
  assert.doesNotMatch(store, /matchingGrantIds[^\n]*metadata/);
  assert.doesNotMatch(
    shadow,
    /membershipId|authorizationEpoch|screenIds|grantIds|error/,
  );
  assert.match(
    schema,
    /authorizationMode\s+AuthorizationMode\s+@default\(LEGACY\)/,
  );
});
