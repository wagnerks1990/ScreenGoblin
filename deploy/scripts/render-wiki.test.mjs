import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdirSync,
  existsSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderWiki } from "./render-wiki.mjs";

const sha = "a".repeat(40);

test("Wiki rendering is deterministic, revision-bound and preserves unmanaged pages", () => {
  const directory = mkdtempSync(join(tmpdir(), "screengoblin-wiki-"));
  try {
    writeFileSync(join(directory, "Home.md"), "Owner content\n");
    renderWiki(process.cwd(), directory, sha);
    const page = readFileSync(
      join(directory, "ScreenGoblin-Documentation.md"),
      "utf8",
    );
    assert.match(page, new RegExp(`/blob/${sha}/docs/PREPRODUCTION.md`));
    assert.doesNotMatch(page, /\/blob\/main\//);
    renderWiki(process.cwd(), directory, sha);
    assert.equal(
      readFileSync(join(directory, "ScreenGoblin-Documentation.md"), "utf8"),
      page,
    );
    assert.equal(
      readFileSync(join(directory, "Home.md"), "utf8"),
      "Owner content\n",
    );
    assert.throws(
      () => renderWiki(process.cwd(), directory, "main"),
      /full source commit/,
    );
    writeFileSync(
      join(directory, "ScreenGoblin-Documentation.md"),
      "Owner page\n",
    );
    assert.throws(() => renderWiki(process.cwd(), directory, sha), /unmanaged/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Wiki publication restricts credentials to protected main and excludes PRs", () => {
  const workflow = readFileSync(".github/workflows/wiki-sync.yml", "utf8");
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.ref_protected/);
  assert.match(workflow, /github\.event_name != 'pull_request'/);
  assert.match(workflow, /persist-credentials: false/g);
  assert.equal((workflow.match(/secrets\.WIKI_TOKEN/g) ?? []).length, 1);
  assert.match(workflow, /git -c credential\.helper= clone/);
  assert.match(
    workflow,
    /git -C "\$workspace\/wiki" -c credential\.helper= push/,
  );
  assert.doesNotMatch(workflow, /https:\/\/[^\s]*\$\{?WIKI_TOKEN/);
});

test("Wiki rendering rejects symlinks without modifying their external target", () => {
  const directory = mkdtempSync(join(tmpdir(), "screengoblin-wiki-symlink-"));
  try {
    const destination = join(directory, "wiki");
    const outside = join(directory, "outside.md");
    const original =
      "<!-- ScreenGoblin managed documentation index -->\nOwner content\n";
    writeFileSync(outside, original);
    mkdirSync(destination);
    symlinkSync(outside, join(destination, "ScreenGoblin-Documentation.md"));
    assert.throws(
      () => renderWiki(process.cwd(), destination, sha),
      /regular file/,
    );
    assert.equal(readFileSync(outside, "utf8"), original);
    rmSync(join(destination, "ScreenGoblin-Documentation.md"));
    symlinkSync(
      join(directory, "missing.md"),
      join(destination, "ScreenGoblin-Documentation.md"),
    );
    assert.throws(
      () => renderWiki(process.cwd(), destination, sha),
      /regular file/,
    );
    assert.equal(existsSync(join(directory, "missing.md")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Wiki writes stay on the opened inode when the pathname becomes a symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "screengoblin-wiki-race-"));
  const originalStat = fs.fstatSync;
  try {
    const destination = join(directory, "wiki");
    mkdirSync(destination);
    const page = join(destination, "ScreenGoblin-Documentation.md");
    const saved = join(destination, "original.md");
    const outside = join(directory, "outside.md");
    const original =
      "<!-- ScreenGoblin managed documentation index -->\nOriginal\n";
    writeFileSync(page, original);
    writeFileSync(outside, original);
    let swapped = false;
    fs.fstatSync = (descriptor, options) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(page, saved);
        symlinkSync(outside, page);
      }
      return originalStat(descriptor, options);
    };
    syncBuiltinESMExports();
    renderWiki(process.cwd(), destination, sha);
    assert.equal(swapped, true);
    assert.equal(readFileSync(outside, "utf8"), original);
    assert.match(readFileSync(saved, "utf8"), /# ScreenGoblin documentation/);
    assert.equal(fs.lstatSync(page).isSymbolicLink(), true);
  } finally {
    fs.fstatSync = originalStat;
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Wiki refuses a symlinked destination directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "screengoblin-wiki-directory-"));
  try {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    const destination = join(directory, "wiki");
    symlinkSync(outside, destination);
    assert.throws(
      () => renderWiki(process.cwd(), destination, sha),
      /regular file/,
    );
    assert.equal(
      existsSync(join(outside, "ScreenGoblin-Documentation.md")),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
