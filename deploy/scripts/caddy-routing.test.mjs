import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const caddyfile = readFileSync(
  new URL("../caddy/Caddyfile", import.meta.url),
  "utf8",
);

test("public readiness is denied by an ordered terminal handler", () => {
  assert.match(
    caddyfile,
    /@readiness path \/health\/ready\n  handle @readiness \{\n    respond 404\n  \}/,
  );
  const readiness = caddyfile.indexOf("handle @readiness");
  const api = caddyfile.indexOf("handle @api");
  const fallback = caddyfile.indexOf("handle {");
  assert.ok(readiness >= 0);
  assert.ok(readiness < api);
  assert.ok(api < fallback);
});
