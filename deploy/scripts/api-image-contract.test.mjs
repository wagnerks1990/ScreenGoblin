import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../docker/api.Dockerfile", import.meta.url),
  "utf8",
);

test("the API image installs and verifies nested workspace dependencies", () => {
  assert.match(dockerfile, /AS production-deps/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.doesNotMatch(dockerfile, /npm prune/);
  assert.match(
    dockerfile,
    /test -f apps\/api\/node_modules\/@prisma\/client\/package\.json/,
  );
  assert.match(
    dockerfile,
    /COPY --from=production-deps[^\n]+\/apps\/api\/node_modules[^\n]+\.\/apps\/api\/node_modules/,
  );
  assert.match(
    dockerfile,
    /COPY --from=build[^\n]+\/apps\/api\/node_modules\/\.prisma[^\n]+\.\/apps\/api\/node_modules\/\.prisma/,
  );
  assert.match(dockerfile, /openssl=3\.0\.20-1~deb12u2/);

  assert.match(
    dockerfile,
    /RUN cd apps\/api[\s\S]+await Promise\.all\(\[import\('@prisma\/client'\), import\('fastify'\), import\('@screengoblin\/contracts'\)\]\)[\s\S]+test -f node_modules\/\.prisma\/client\/schema\.prisma/,
  );
});
