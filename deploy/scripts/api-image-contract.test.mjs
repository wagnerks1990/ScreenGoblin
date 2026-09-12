import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../docker/api.Dockerfile", import.meta.url),
  "utf8",
);

test("the API image retains and verifies workspace runtime dependencies", () => {
  assert.match(dockerfile, /npm prune --omit=dev/);
  assert.match(dockerfile, /--workspace @screengoblin\/api/);
  assert.match(dockerfile, /--workspace @screengoblin\/contracts/);

  const runtimeAssertions = dockerfile.match(
    /await Promise\.all\(\[import\('@prisma\/client'\), import\('fastify'\), import\('@screengoblin\/contracts'\)\]\)/g,
  );
  assert.equal(runtimeAssertions?.length, 2);
  assert.equal(
    dockerfile.match(/test -f node_modules\/\.prisma\/client\/schema\.prisma/g)
      ?.length,
    2,
  );
});
