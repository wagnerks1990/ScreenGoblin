import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
