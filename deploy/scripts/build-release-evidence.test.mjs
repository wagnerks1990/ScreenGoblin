import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("build-release-evidence.sh", import.meta.url),
);

function runFixture(failingImage, failureCode = "1") {
  const root = mkdtempSync(join(tmpdir(), "screengoblin-image-evidence-"));
  const bin = join(root, "bin");
  const repository = join(root, "repository");
  mkdirSync(bin);
  mkdirSync(join(repository, "deploy/docker"), { recursive: true });
  for (const name of ["api", "console", "player"]) {
    writeFileSync(
      join(repository, `deploy/docker/${name}.Dockerfile`),
      "fixture\n",
    );
  }
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "Fixture",
    ],
  ]) {
    execFileSync("git", args, { cwd: repository });
  }
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\nif [ "$1" = image ]; then printf '{}\\n'; fi\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "trivy"),
    `#!/bin/sh
output=
previous=
gate=false
for argument in "$@"; do
  if [ "$previous" = --output ]; then output="$argument"; fi
  if [ "$argument" = --exit-code ]; then gate=true; fi
  previous="$argument"
done
if [ -n "$output" ]; then printf '{}\\n' > "$output"; fi
if [ "$gate" = true ]; then
  case "$*" in *"/$FAILING_IMAGE:"*) exit "$FAILURE_CODE";; esac
fi
`,
    { mode: 0o700 },
  );
  const output = join(root, "evidence");
  const result = spawnSync("bash", [script], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RELEASE_EVIDENCE_DIR: output,
      RELEASE_EVIDENCE_ID: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      TRIVY_BIN: "trivy",
      FAILING_IMAGE: failingImage,
      FAILURE_CODE: failureCode,
    },
  });
  return { root, output, result };
}

for (const code of ["1", "2"]) {
  test(`a Console scan failure (exit ${code}) retains all image evidence and blocks qualification`, () => {
    const { root, output, result } = runFixture("console", code);
    try {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Security qualification failed for 1 image/);
      for (const name of ["api", "console", "player-web"]) {
        assert.equal(
          readFileSync(join(output, `sbom/${name}.cdx.json`), "utf8"),
          "{}\n",
        );
        assert.equal(
          readFileSync(join(output, `sarif/${name}.sarif`), "utf8"),
          "{}\n",
        );
      }
      assert.equal(
        readFileSync(join(output, "images/console.security-gate.txt"), "utf8"),
        `failed (exit ${code})\n`,
      );
      execFileSync("sha256sum", ["--check", "--strict", "SHA256SUMS"], {
        cwd: output,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("all clean image scans produce successful checksum-bound evidence", () => {
  const { root, output, result } = runFixture("none");
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Evidence written/);
    assert.equal(
      readFileSync(join(output, "images/player-web.security-gate.txt"), "utf8"),
      "passed\n",
    );
    execFileSync("sha256sum", ["--check", "--strict", "SHA256SUMS"], {
      cwd: output,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
