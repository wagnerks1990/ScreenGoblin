# Resend communications validation - 2026-11-12

Scope: optional email recovery, opted-in offline/recovery alerts, tenant-mapped
inbound receipts and Console Notifications. Preproduction and emergency release
gates remain unchanged and are not certified complete by this review.

## Executed checks

- Clean LF source export, pinned Node 22 Linux container: `npm ci` and
  `npm run validate` passed. Repository 136, API 388, Console 123, Player 235:
  **882 tests passed, zero failed/skipped**. Builds, lint, types, formatting,
  static dependency/license policy and container/Gradle input integrity passed.
- Disposable loopback PostgreSQL 17: all migrations and
  `npm run test:integration -w @screengoblin/api` passed: **91 tests**, including
  16 mail cases. Recovery consumes once, revokes cross-tenant session/issuer
  authority, rolls back on audit failure, bounds tokens and preserves isolation.
  Outbox tests cover ambiguous retries, worker contention, early delivery events,
  complaints, opt-out cancellation and deduplicated offline/recovery transitions.
- Disposable owner/runtime identities: privilege reconciliation and
  `npm run test:integration:runtime-role -w @screengoblin/api` passed:
  **4 tests**. The runtime role can process encrypted mail/receipts while database
  escape, schema ownership and append-only evidence mutations remain denied.
- Pinned Chromium Linux container: `npm run test:e2e:console` passed:
  **15 tests, zero failed/skipped/flaky** in the final run. Includes existing
  live API flows and WCAG checks plus mocked recovery/mail browser contracts.
  New forms and Notifications passed automated WCAG checks at 390/1280 widths;
  screenshots were inspected. Horizontal table overflow was reproduced and fixed.
  Fixture cleanup now honors the unchanged global rate-limit cooldown.
- Final CSS/browser-only adjustments received targeted formatting and browser
  checks after the full validation run. API behavior was unchanged afterwards.
- Protected deployment backup restoration and the additive migration were
  rehearsed on an isolated database without public ports. No database rollback
  or existing-account password reset was performed.

The first runtime-role attempt lacked OpenSSL in its disposable runner; installing
that runner prerequisite resolved Prisma engine detection. No schema or checks
were weakened. The existing exact SigV4 exception was refreshed only after
reviewing the unchanged S3 argument/derivation flow; all other SARIF matching and
source constraints remain exact. This is not a new CodeQL/ZAP scan result.

## Acceptance boundaries

Provider domain/DKIM/SPF/receiving DNS verification is operational setup evidence.
Automated transport tests use a fake provider, and browser mail state uses mocks.
They do not prove a message reached a real inbox, live receiving webhooks, an
actual user recovery session, or physical screen behavior. Complete explicit
self-addressed send/inbox and non-sensitive inbound acceptance checks separately.
Never email reset tokens, runtime credentials, student data or operational screen
content in validation reports. Retain the documented additive rollback path.
