import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../../.github/workflows/release-evidence.yml",
  import.meta.url,
);

test("release provenance privileges and attestation stay tag-only", async () => {
  const source = await readFile(workflowUrl, "utf8");
  const topPermissions = source.slice(
    source.indexOf("\npermissions:"),
    source.indexOf("\njobs:"),
  );
  const evidence = source.slice(
    source.indexOf("\n  evidence:"),
    source.indexOf("\n  provenance:"),
  );
  const provenance = source.slice(source.indexOf("\n  provenance:"));

  assert.doesNotMatch(topPermissions, /(?:id-token|attestations):\s*write/);
  assert.doesNotMatch(evidence, /(?:id-token|attestations):\s*write/);
  assert.match(
    provenance,
    /if: github\.event_name == 'push' && github\.ref_type == 'tag'/,
  );
  assert.match(provenance, /attestations:\s*write/);
  assert.match(provenance, /id-token:\s*write/);
  assert.match(
    evidence,
    /if: github\.event_name == 'workflow_dispatch'[\s\S]*name: unsigned-release-evidence-/,
  );
  assert.match(
    evidence,
    /if: github\.event_name == 'push' && github\.ref_type == 'tag'[\s\S]*retention-days: 1/,
  );

  const attest = provenance.indexOf("actions/attest-build-provenance@");
  const verify = provenance.indexOf("gh attestation verify");
  const publish = provenance.indexOf("name: attested-release-evidence-");
  assert.ok(attest >= 0, "tag job must create an artifact attestation");
  assert.ok(verify > attest, "tag job must verify after attesting");
  assert.ok(publish > verify, "tag job must publish only after verification");
});
