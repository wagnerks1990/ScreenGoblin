# PostgreSQL integration tests

This suite exercises `PrismaStore` against the migrated PostgreSQL schema. It
uses and truncates the database named by `DATABASE_URL`; never point it at a
shared or production database.

```bash
npm run prisma:generate -w @screengoblin/api
npm run prisma:migrate -w @screengoblin/api
SCREEN_GOBLIN_ALLOW_TEST_DATABASE_RESET=true npm run test:integration -w @screengoblin/api
```

As destructive-test safeguards, the suite requires the explicit reset flag and
refuses any target other than the exact database `screengoblin_test` on a
loopback host (`127.0.0.1`, `localhost`, or `::1`).

Coverage includes tenant-scoped reads and ID substitution, concurrent one-time
pairing with its required audit, transactional rollback when the audit cannot
be written, composite tenant constraints for playlist items, schedules,
targets, and pairing links, migration-safe cascading/detaching deletes,
database unique constraints, safe-range `BIGINT` conversion, case-insensitive
email lookup, deterministic compatibility membership selection, and
individually revocable user-session races, rollback, expiry, and tenant scope.
It also verifies serialized failed-login telemetry inserts, retention/cap
pruning, newest-event preservation, and database rejection of non-HMAC keys.
Schedule publication coverage includes tenant-bound command keys, concurrent
same-key serialization, lost-response replay after withdrawal, fresh-key
intentional republication, authorization races, durable expired tombstones,
and rollback when either audit or idempotency persistence fails.
Audit coverage also exercises bounded scalar/JSON fields, the authoritative 16
KiB `metadata::text` limit through transactional mutations, rejection of
compressible oversized legacy metadata during constraint validation, stable
equal-time ordering, direct update/delete rejection under the current
table-owning test login, `User` attribution nulling, and `Organization` audit
cascade behavior.
The owner credential can still disable the trigger or truncate the table; the
test therefore does not establish hostile-database tamper resistance.

Known contract gaps are intentionally not hidden by the harness:

- Login has no organization selector. For compatibility, multi-organization
  login deterministically selects the lexically first organization ID; a future
  explicit organization-selection flow remains preferable.
- DTO counters are JavaScript `number` values. The store rejects database
  values above `Number.MAX_SAFE_INTEGER` instead of returning imprecise data.

The immutable-release migration deliberately aborts if legacy `Schedule` rows
exist. SQL cannot safely reconstruct the application-defined canonical release
digest and frozen target/content snapshots. Before applying that migration to
an existing environment, operators must explicitly convert or remove legacy
schedules in a backed-up maintenance window, verify the resulting immutable
release records on a staging restore, and only then deploy the new manifest
reader. The migration never silently blanks previously scheduled screens.

Published releases retain composite tenant-bound references to their source
playlist, playlist items, and media with `ON DELETE RESTRICT`. Draft metadata
may change without changing a frozen release, but referenced source deletion is
intentionally refused until an explicit archival/retention workflow exists.

Assignment targets retain the published `screenId` as immutable history while
their nullable live-screen pointer uses `ON DELETE SET NULL`. Deleting a screen
therefore removes live targeting without erasing the release assignment's
original target snapshot.
