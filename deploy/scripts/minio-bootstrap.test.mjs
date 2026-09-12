import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bootstrap = new URL("../minio/create-bucket.sh", import.meta.url);
const policy = new URL("../minio/api-policy.json", import.meta.url);

const fakeMc = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MINIO_TEST_COMMAND_LOG"
case "$*" in
  "admin policy info "*) exit 1 ;;
  "admin user info "*) exit 1 ;;
  *) exit 0 ;;
esac
`;

test("renders the tenant bucket policy without utilities absent from the mc image", () => {
  const root = mkdtempSync(join(tmpdir(), "minio-bootstrap-test-"));
  const bin = join(root, "bin");
  const mc = join(bin, "mc");
  const output = join(root, "rendered-policy.json");
  const commandLog = join(root, "commands.log");
  mkdirSync(bin);
  writeFileSync(mc, fakeMc);
  chmodSync(mc, 0o755);

  try {
    const result = spawnSync("/bin/sh", [bootstrap.pathname], {
      encoding: "utf8",
      env: {
        PATH: bin,
        MINIO_ROOT_USER: "test-root",
        MINIO_ROOT_PASSWORD: "test-root-password",
        S3_BUCKET: "screengoblin-test-media",
        S3_ACCESS_KEY_ID: "test-api",
        S3_SECRET_ACCESS_KEY: "test-api-password",
        MINIO_POLICY_TEMPLATE: policy.pathname,
        MINIO_POLICY_OUTPUT: output,
        MINIO_TEST_COMMAND_LOG: commandLog,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const rendered = readFileSync(output, "utf8");
    assert.ok(!rendered.includes("__BUCKET__"));
    assert.deepEqual(
      JSON.parse(rendered).Statement.map((entry) => entry.Resource[0]),
      [
        "arn:aws:s3:::screengoblin-test-media",
        "arn:aws:s3:::screengoblin-test-media/*",
      ],
    );

    const commands = readFileSync(commandLog, "utf8");
    assert.match(commands, /admin policy create local screengoblin-media-rw/);
    assert.match(commands, /admin user add local test-api test-api-password/);
    assert.match(
      commands,
      /anonymous set download local\/screengoblin-test-media/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
