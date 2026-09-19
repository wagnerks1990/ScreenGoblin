# Isolated Console browser tests

## Boundary

These tests mutate data: they create synthetic media metadata, rotate three
bootstrap passwords, and exercise maker-checker publication against disposable
fixtures. They are not a deployment health check. Never run them against a pilot,
production database, real organization, real player, or a forwarded production
connection, even when the local endpoint is named like a test database.

The authoritative environment and setup order are the `browser-e2e` job in
[CI](../.github/workflows/ci.yml). Use a fresh disposable PostgreSQL instance and
fixture-only credentials. Do not source `deploy/.env` or an operator's API `.env`.

`setup-safety.mjs` requires all of the following before fixture activity:

- `NODE_ENV=test` and `SCREEN_GOBLIN_ALLOW_E2E_MUTATIONS=true`.
- `DATABASE_URL` uses `postgres://` or `postgresql://`, the exact database name
  `screengoblin_e2e`, and `127.0.0.1`, `localhost`, or `[::1]`. The only optional
  query is exactly `schema=public`; alternate databases, schemas, encoded path
  spellings, fragments, and driver-specific host/options overrides are rejected.
- `MEDIA_ALLOWED_ORIGINS=http://127.0.0.1:4173` and
  `SEED_ORGANIZATION_SLUG=screengoblin-e2e`. Optional API/host/port overrides must
  match the existing Playwright servers, not another reachable endpoint.

Validation runs when Playwright loads its configuration and again at the setup
entrypoint, before loading or constructing Prisma. CI also invokes it before
migration and seed commands. Standalone migration/seed commands do not implicitly
invoke this browser guard: use the explicit preflight below before running them.
All required owner, publisher, and administrator fixture credentials are checked
before the media insert. Errors do not echo a database URL or its credentials.

Playwright must own both servers. Existing listeners on ports 3000 or 4173 cause
failure rather than reuse; stop only the disposable test servers or use another
isolated host. Do not change `reuseExistingServer` to work around this protection.
Bootstrap requests have bounded timeouts and reject redirects, including redirects
that could replay a password-bearing body to another origin.

## Running and verifying

After preparing the disposable database and the fixture-only environment from
`browser-e2e`, run this preflight from the repository root **before any migrations,
seeding, or provisioning**:

```bash
node --input-type=module -e \
  'import { assertE2eEnvironment } from "./e2e/setup-safety.mjs"; assertE2eEnvironment(process.env)'
```

Follow that job's migration, owner seed, offline publisher/admin provisioning,
and API/Console build steps without substituting deployment credentials. Then:

```bash
npm run test:e2e:console
```

The dependency-free boundary/timing checks and setup execution with mocked
Prisma/fetch can also be run separately on current Node 22:

```bash
node --test deploy/scripts/e2e-*.test.mjs
```

Older Node 22 releases without the built-in TypeScript stripper use the existing
repository TypeScript development dependency for the setup-code unit test;
`npm ci` is required in that case. No production package or runtime is changed.

The setup's first owner response anchors a monotonic cooldown of 60 seconds plus
500 milliseconds. Network delay before that response cannot shorten the wait;
early timer wakeups recheck the remaining floor. This preserves the real login
limiter rather than relaxing it for tests. Credentials remain deterministically
rotated in memory, and each setup verification session is logged out.

## Evidence and recovery

The isolated Chromium suite covers real API/database authentication and the
separate publisher/admin workflow; the media metadata fixture is not proof of
object ingestion, scanning, delivery, or physical playback. The setup unit tests
mock database and HTTP effects and do not replace that browser gate.

Do not retain traces, screenshots, video, storage state, database dumps, or
credential-bearing diagnostics. On fixture setup failure, stop its isolated
servers and recreate only its disposable database/environment using the existing
CI fixture procedure. Never reset, rotate, or clean up a production identity to
repair an E2E run. This change has no production schema migration or deployment
step and does not close any physical-device or operational pilot gate.
