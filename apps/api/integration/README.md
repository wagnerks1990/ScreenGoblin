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
be written, database unique constraints, safe-range `BIGINT` conversion,
case-insensitive email lookup, and deterministic compatibility membership
selection.

Known contract gaps are intentionally not hidden by the harness:

- Login has no organization selector. For compatibility, multi-organization
  login deterministically selects the lexically first organization ID; a future
  explicit organization-selection flow remains preferable.
- DTO counters are JavaScript `number` values. The store rejects database
  values above `Number.MAX_SAFE_INTEGER` instead of returning imprecise data.
- The initial schema does not prevent every cross-tenant nested relation at the
  database layer. Composite tenant foreign keys and their direct constraint
  tests belong to the planned schema migration and must remain a release gate.
