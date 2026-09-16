import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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

const wrapper = new URL(
  "../postgres/provision-runtime-role.sh",
  import.meta.url,
);
const sql = readFileSync(
  new URL("../postgres/provision-runtime-role.sql", import.meta.url),
  "utf8",
);
const verificationSql = readFileSync(
  new URL("../postgres/verify-runtime-role.sql", import.meta.url),
  "utf8",
);

test("runtime role provisioning is identifier-safe and least privilege", () => {
  assert.match(sql, /format\(\s*'CREATE ROLE %I/);
  assert.match(sql, /ALTER ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER/);
  assert.match(sql, /NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(sql, /REVOKE %I FROM %I/);
  assert.match(sql, /runtime_owns_nothing/);
  assert.match(sql, /REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC/);
  assert.match(sql, /GRANT CONNECT ON DATABASE %I TO %I/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC/);
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO %I/);
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I/,
  );
  assert.match(sql, /GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I/);
  assert.match(
    sql,
    /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM %I[\s\S]*'_prisma_migrations'/,
  );
  assert.match(
    sql,
    /REVOKE UPDATE, DELETE ON TABLE public\.%I, public\.%I FROM %I[\s\S]*'AuditEvent'[\s\S]*'MembershipAttribution'/,
  );
  assert.match(
    sql,
    /REVOKE DELETE ON TABLE public\.%I, public\.%I FROM %I[\s\S]*'Organization'[\s\S]*'User'/,
  );
  assert.doesNotMatch(sql, /ALL TYPES IN SCHEMA/i);
  assert.match(sql, /type_object\.typtype IN \('d', 'e'\)/);
  assert.match(sql, /GRANT USAGE ON TYPE %I\.%I TO %I/);
  assert.doesNotMatch(
    sql,
    /GRANT[^;\n]*(?:CREATE|TRUNCATE|TRIGGER|REFERENCES)/i,
  );
  assert.doesNotMatch(sql, /GRANT\s+%I\s+TO\s+%I/i);
});

test("function defaults are closed and only the required scalar is executable", () => {
  assert.match(
    sql,
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.%I\(jsonb, integer\) TO %I/,
  );
  assert.match(sql, /'audit_event_metadata_shape_valid'/);
  assert.match(
    sql,
    /ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/,
  );
  assert.doesNotMatch(
    sql,
    /IN SCHEMA public REVOKE (?:EXECUTE ON FUNCTIONS|ALL PRIVILEGES ON TYPES) FROM PUBLIC/,
  );
  assert.doesNotMatch(sql, /ALTER DEFAULT PRIVILEGES[^']*GRANT[^']*TO %I/);
  for (const triggerFunction of [
    "enforce_user_session_purpose",
    "guard_access_grant_lifecycle",
    "reject_audit_event_mutation",
  ]) {
    assert.doesNotMatch(
      sql,
      new RegExp(`GRANT EXECUTE[^\\n]*${triggerFunction}`),
    );
  }
});

test("wrapper keeps the runtime password out of process arguments", () => {
  const fixture = mkdtempSync(join(tmpdir(), "screengoblin-db-role-"));
  try {
    const bin = join(fixture, "bin");
    const temporaryDirectory = join(fixture, "tmp");
    mkdirSync(bin);
    mkdirSync(temporaryDirectory);
    const fakePsql = join(bin, "psql");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
set -eu
printf '%s\\n' "$@" >> "$ARGUMENT_CAPTURE"
printf '%s\\n' "$PGSERVICE" >> "$SERVICE_NAME_CAPTURE"
printf '%s\\n' "$PGSERVICEFILE" >> "$SERVICE_PATH_CAPTURE"
cat "$PGSERVICEFILE" >> "$SERVICE_CONTENT_CAPTURE"
[ "$(stat -c '%a' "$PGSERVICEFILE")" = 600 ]
[ "\${PGDATABASE+x}" != x ]
[ "$POSTGRES_RUNTIME_PASSWORD" = 'runtime secret with spaces' ]
`,
    );
    chmodSync(fakePsql, 0o755);

    const result = spawnSync("sh", [wrapper.pathname], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: temporaryDirectory,
        ARGUMENT_CAPTURE: join(fixture, "arguments"),
        SERVICE_NAME_CAPTURE: join(fixture, "service-names"),
        SERVICE_PATH_CAPTURE: join(fixture, "service-paths"),
        SERVICE_CONTENT_CAPTURE: join(fixture, "service-contents"),
        MIGRATION_DATABASE_URL:
          "postgresql://migration@example.test/screen?schema=public",
        DATABASE_URL: "postgresql://runtime@example.test/screen?schema=public",
        POSTGRES_USER: "migration owner",
        POSTGRES_RUNTIME_USER: 'runtime "role"',
        POSTGRES_RUNTIME_PASSWORD: "runtime secret with spaces",
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const argumentsUsed = readFileSync(join(fixture, "arguments"), "utf8");
    assert.match(argumentsUsed, /--set=migrator_role=migration owner/);
    assert.match(argumentsUsed, /--set=runtime_role=runtime "role"/);
    assert.match(argumentsUsed, /--file=.*provision-runtime-role\.sql/);
    assert.match(argumentsUsed, /--file=.*verify-runtime-role\.sql/);
    assert.doesNotMatch(argumentsUsed, /runtime secret/);
    assert.doesNotMatch(argumentsUsed, /postgresql:\/\//);
    assert.equal(
      readFileSync(join(fixture, "service-names"), "utf8"),
      "migration\nruntime\n",
    );
    assert.equal(
      readFileSync(join(fixture, "service-contents"), "utf8"),
      "[migration]\ndbname=postgresql://migration@example.test/screen\n[runtime]\ndbname=postgresql://runtime@example.test/screen\n".repeat(
        2,
      ),
    );
    const servicePaths = readFileSync(join(fixture, "service-paths"), "utf8")
      .trim()
      .split("\n");
    assert.equal(new Set(servicePaths).size, 1);
    assert.equal(existsSync(servicePaths[0]), false);
    assert.doesNotMatch(argumentsUsed, /runtime@example\.test/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("wrapper fails before psql when identities are not separated", () => {
  const result = spawnSync("sh", [wrapper.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: "postgresql://migration@example.test/screen",
      DATABASE_URL: "postgresql://same-role@example.test/screen",
      POSTGRES_USER: "same-role",
      POSTGRES_RUNTIME_USER: "same-role",
      POSTGRES_RUNTIME_PASSWORD: "not-a-real-secret",
    },
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must differ/);
});

test("wrapper rejects ambiguous or unsupported Prisma URL queries", () => {
  for (const databaseUrl of [
    "postgresql://runtime@example.test/screen?schema=other",
    "postgresql://runtime@example.test/screen?sslmode=require&schema=public",
    "postgresql://runtime@example.test/screen?schema=public&schema=public",
    "postgresql://runtime@example.test/screen?schema=public#fragment",
  ]) {
    const result = spawnSync("sh", [wrapper.pathname], {
      encoding: "utf8",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: "postgresql://migration@example.test/screen",
        DATABASE_URL: databaseUrl,
        POSTGRES_USER: "migration",
        POSTGRES_RUNTIME_USER: "runtime",
        POSTGRES_RUNTIME_PASSWORD: "not-a-real-secret",
      },
    });
    assert.equal(result.status, 64);
    assert.doesNotMatch(result.stderr, /postgresql:\/\//);
  }
});

test("deployment URL verifies runtime identity and denied capabilities", () => {
  assert.match(verificationSql, /session_user = :'runtime_role'/);
  assert.match(verificationSql, /current_user = :'runtime_role'/);
  assert.match(verificationSql, /NOT role_state\.rolinherit/);
  assert.match(verificationSql, /NOT role_state\.rolsuper/);
  assert.match(verificationSql, /pg_catalog\.pg_auth_members/);
  assert.match(
    verificationSql,
    /NOT has_database_privilege\(current_user, current_database\(\), 'TEMPORARY'\)/,
  );
  assert.match(
    verificationSql,
    /NOT has_schema_privilege\(current_user, 'public', 'CREATE'\)/,
  );
  assert.match(
    verificationSql,
    /_prisma_migrations[\s\S]*'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'/,
  );
  assert.match(verificationSql, /relation_object\.relkind IN \('r', 'p'\)/);
  assert.match(
    verificationSql,
    /DATABASE_URL does not satisfy the runtime database-role contract/,
  );
});
