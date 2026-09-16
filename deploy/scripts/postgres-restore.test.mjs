import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const restoreScript = new URL("./postgres-restore.sh", import.meta.url);
const source = readFileSync(restoreScript, "utf8");

test("restore reapplies runtime grants and checks allowed and denied access", () => {
  assert.match(source, /pg_restore --exit-on-error --no-owner --no-acl/);
  assert.match(source, /run --rm --no-deps[\s\\]*\n[\s\S]*api-db-privileges/);
  assert.match(source, /provision-runtime-role\.sh/);
  assert.match(source, /export DATABASE_URL=.*POSTGRES_RESTORE_TARGET_DB/);
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    assert.match(
      source,
      new RegExp(
        `has_table_privilege\\(current_user, .*public\\.\\"Screen\\".*, .*${privilege}`,
      ),
    );
  }
  assert.match(source, /SELECT 1 FROM public\."User" LIMIT 1/);
  assert.match(source, /BEGIN;[\s\S]*UPDATE public\."Screen"[\s\S]*ROLLBACK;/);
  assert.match(source, /SELECT 1 FROM public\."_prisma_migrations" LIMIT 1/);
  assert.match(source, /TRUNCATE TABLE public\."User"/);
  assert.match(source, /CREATE SCHEMA runtime_restore_probe/);
  assert.match(source, /remove_incomplete_restore[\s\S]*dropdb --force/);
  assert.match(
    source,
    /if ! docker compose[\s\S]*api-db-privileges[\s\S]*then\n  remove_incomplete_restore\n  exit 1/,
  );
});

test("failed privilege reconciliation removes the restored database", () => {
  const fixture = mkdtempSync(join(tmpdir(), "screengoblin-restore-"));
  try {
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    const backup = join(fixture, "backup.dump");
    const envFile = join(fixture, "deploy.env");
    const commandLog = join(fixture, "commands.log");
    writeFileSync(backup, "fixture backup");
    const checksum = spawnSync("sha256sum", [backup], { encoding: "utf8" });
    assert.equal(checksum.status, 0, checksum.stderr);
    writeFileSync(`${backup}.sha256`, checksum.stdout);
    writeFileSync(envFile, "fixture=true\n");

    const fakeDocker = join(bin, "docker");
    writeFileSync(
      fakeDocker,
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$*" in
  *'printf %s "$POSTGRES_DB"'*) printf 'screengoblin' ;;
  *'SELECT 1 FROM pg_database'*) : ;;
  *'run --rm --no-deps '*api-db-privileges*) exit 42 ;;
  *) : ;;
esac
`,
    );
    chmodSync(fakeDocker, 0o755);

    const result = spawnSync("bash", [restoreScript.pathname, backup], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_COMMAND_LOG: commandLog,
        SCREENGOBLIN_ENV_FILE: envFile,
      },
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /privilege reconciliation or runtime validation failed/,
    );
    assert.doesNotMatch(result.stdout, /validated runtime access/);
    const commands = readFileSync(commandLog, "utf8");
    assert.match(
      commands,
      /run --rm --no-deps --env POSTGRES_RESTORE_TARGET_DB=/,
    );
    assert.match(commands, /dropdb --force/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
