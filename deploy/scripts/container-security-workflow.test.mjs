import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/container-scan.yml";

test("repository workflow has distinct blocking static scanners", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /--scanners vuln[\s\S]*--exit-code 1/);
  assert.match(workflow, /--scanners secret[\s\S]*--exit-code 1/);
  assert.match(
    workflow,
    /trivy" config[\s\S]*--skip-check-update[\s\S]*--exit-code 1/,
  );
  assert.match(workflow, /--scanners license[\s\S]*--include-dev-deps/);
  assert.match(workflow, /validate-static-security-policy\.mjs/);
  assert.match(workflow, /--ignorefile "\$RUNNER_TEMP\/trivyignore\.yaml"/);
});

test("reports are retained only after successful blocking scans", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const repositoryJob = workflow.split("\n  images:")[0];

  assert.match(
    repositoryJob,
    /name: repository-security-evidence-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.match(repositoryJob, /if: success\(\)/);
  assert.doesNotMatch(repositoryJob, /if: always\(\)/);
  assert.match(repositoryJob, /sha256sum --check --strict/);
});

test("workflow has no broad scanner suppression switches", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.doesNotMatch(workflow, /--skip-(dirs|files)/);
  assert.doesNotMatch(workflow, /--ignore-policy/);
  assert.doesNotMatch(workflow, /--ignorefile\s+\/dev\/null/);
  assert.match(workflow, /security\/static-scan-exceptions\.json/);
  assert.match(workflow, /security\/dependency-license-policy\.json/);
});

test("final images declare least privilege and health checks", async () => {
  const [api, consoleImage, player] = await Promise.all([
    readFile("deploy/docker/api.Dockerfile", "utf8"),
    readFile("deploy/docker/console.Dockerfile", "utf8"),
    readFile("deploy/docker/player.Dockerfile", "utf8"),
  ]);

  assert.match(api, /USER screengoblin\nHEALTHCHECK/);
  assert.doesNotMatch(api, /RUN cd /);
  for (const dockerfile of [consoleImage, player]) {
    assert.match(dockerfile, /USER nginx\nHEALTHCHECK/);
  }
});
