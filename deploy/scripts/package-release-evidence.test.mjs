import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
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

async function writeFixture(directory) {
  await fs.mkdir(join(directory, "nested"), { recursive: true });
  const readme = join(directory, "README.txt");
  const result = join(directory, "nested", "result.json");
  await fs.writeFile(readme, "evidence\n", { mode: 0o600 });
  await fs.writeFile(result, '{"ok":true}\n', { mode: 0o600 });
}

test("release evidence archive is deterministic", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "screengoblin-evidence-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await writeFixture(first);
    await writeFixture(second);

    const early = new Date(1_000);
    const late = new Date(10_000);
    await fs.utimes(join(first, "README.txt"), early, early);
    await fs.utimes(join(second, "README.txt"), late, late);

    const firstArchive = join(root, "first.tar.gz");
    const secondArchive = join(root, "second.tar.gz");
    await execFileAsync(script, [first, firstArchive]);
    await execFileAsync(script, [second, secondArchive]);

    const firstBytes = await fs.readFile(firstArchive);
    const secondBytes = await fs.readFile(secondArchive);
    assert.deepEqual(firstBytes, secondBytes);

    const checksum = `${firstArchive}.sha256`;
    await execFileAsync("sha256sum", ["--check", "--strict", checksum], {
      cwd: root,
    });
    await assert.rejects(
      execFileAsync(script, [first, firstArchive]),
      /Refusing to overwrite/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
