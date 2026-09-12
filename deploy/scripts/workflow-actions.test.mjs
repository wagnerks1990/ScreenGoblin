import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflows = [
  "ci.yml",
  "codeql.yml",
  "container-scan.yml",
  "dependency-review.yml",
  "recovery-drill.yml",
  "release-evidence.yml",
];

const expected = new Map([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020 # v7.0.0"],
  [
    "actions/upload-artifact",
    "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  ],
  [
    "actions/download-artifact",
    "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
  ],
  [
    "actions/attest-build-provenance",
    "4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2",
  ],
  ["actions/setup-java", "de7274f081f381c8f8158605e0321c36c376e2e6 # v6.0.1"],
  [
    "gradle/actions/setup-gradle",
    "9c971963bec38e04b3d30dcc455b5382be2fdbfb # v6.3.0",
  ],
  [
    "github/codeql-action/init",
    "b96794f015dfd88f77b49b1c93e0fa7110f94c63 # v4.38.0",
  ],
  [
    "github/codeql-action/analyze",
    "b96794f015dfd88f77b49b1c93e0fa7110f94c63 # v4.38.0",
  ],
  [
    "github/codeql-action/upload-sarif",
    "b96794f015dfd88f77b49b1c93e0fa7110f94c63 # v4.38.0",
  ],
  [
    "actions/dependency-review-action",
    "a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0",
  ],
]);

test("security workflows use the reviewed full-SHA action set", async () => {
  const observed = new Set();
  for (const workflow of workflows) {
    const source = await readFile(
      new URL(`../../.github/workflows/${workflow}`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(/^\s*- uses: ([^@\s]+)@([^\n]+)$/gm)) {
      const [, action, pin] = match;
      assert.ok(action);
      assert.ok(pin);
      const reviewed = expected.get(action);
      assert.ok(reviewed, `${workflow} uses unreviewed action ${action}`);
      assert.equal(
        pin.trim(),
        reviewed,
        `${workflow} has a stale pin for ${action}`,
      );
      observed.add(action);
    }
  }
  assert.deepEqual(observed, new Set(expected.keys()));
});
