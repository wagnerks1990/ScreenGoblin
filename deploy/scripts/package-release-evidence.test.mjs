import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "package-release-evidence.sh",
);

test("release evidence packaging is deterministic and checksum-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "screengoblin-evidence-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    for (const directory of [first, second]) {
      await mkdir(join(directory, "nested"), { recursive: true });
      await writeFile(join(directory, "README.txt"), "evidence\n", {
        mode: 0o600,
      });
      await writeFile(join(directory, "nested", "result.json"), '{"ok":true}\n', {
        mode: 0o600,
      });
    }
    await utimes(join(first, "README.txt"), new Date(1_000), new Date(2_000));
    await utimes(join(second, "README.txt"), new Date(9_000), new Date(10_000));

    const firstArchive = join(root, "first.tar.gz");
    const secondArchive = join(root, "second.tar.gz");
    await execFileAsync(script, [first, firstArchive]);
    await execFileAsync(script, [second, secondArchive]);

    assert.deepEqual(await readFile(firstArchive), await readFile(secondArchive));
    await execFileAsync("sha256sum", [
      "--check",
      "--strict",
      `${firstArchive}.sha256`,
    ]);
    await assert.rejects(
      execFileAsync(script, [first, firstArchive]),
      /Refusing to overwrite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
