import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceUrl = new URL(
  "../../apps/player/android/app/src/main/java/com/screengoblin/player/BootReceiver.java",
  import.meta.url,
);

test("BootReceiver verifies the exact received action before side effects", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const nullGuard = source.indexOf("if (intent == null) return;");
  const actionGuard = source.indexOf(
    "if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;",
  );
  const launch = source.indexOf("context.startActivity(player);");

  assert.ok(nullGuard >= 0, "the received Intent must be null-checked");
  assert.ok(
    actionGuard > nullGuard,
    "BOOT_COMPLETED must be compared directly with the received action",
  );
  assert.ok(
    launch > actionGuard,
    "the action guard must execute before the activity-launch side effect",
  );
  assert.deepEqual(
    [...source.matchAll(/Intent\.ACTION_[A-Z_]+/g)].map((match) => match[0]),
    ["Intent.ACTION_BOOT_COMPLETED"],
    "the receiver must not broaden its runtime action allowlist",
  );
});

test("CodeQL acceptance fails closed when the reviewed receiver changes", async () => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const receiverPath =
    "apps/player/android/app/src/main/java/com/screengoblin/player/BootReceiver.java";
  const sandbox = await mkdtemp(join(tmpdir(), "screengoblin-boot-receiver-"));
  const results = join(sandbox, "results");
  const sandboxReceiver = join(sandbox, receiverPath);
  const finding = {
    ruleId: "java/improper-intent-verification",
    message: { text: "receiver action verification finding" },
    locations: [
      { physicalLocation: { artifactLocation: { uri: receiverPath } } },
    ],
  };

  try {
    await mkdir(dirname(sandboxReceiver), { recursive: true });
    await mkdir(results);
    await copyFile(fileURLToPath(sourceUrl), sandboxReceiver);
    await writeFile(
      join(results, "java.sarif"),
      JSON.stringify({ runs: [{ results: [finding] }] }),
    );

    const gate = join(
      repositoryRoot,
      "deploy/scripts/block-codeql-findings.sh",
    );
    const accepted = spawnSync("bash", [gate, "results"], {
      cwd: sandbox,
      encoding: "utf8",
    });
    assert.equal(accepted.status, 0, accepted.stderr);

    await writeFile(sandboxReceiver, "// changed\n", { flag: "a" });
    const rejected = spawnSync("bash", [gate, "results"], {
      cwd: sandbox,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /1 first-party finding/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
