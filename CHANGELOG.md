# Changelog

All notable changes are documented here. ScreenGoblin follows semantic versioning once a stable public release exists; `0.x` releases remain prototype interfaces.

## Unreleased

### Security

- Add the Android Keystore P-256 device-identity foundation with StrongBox
  preference, public-key fingerprint installation IDs for new Android installs,
  and domain-separated challenge signing. Server-side enrollment and proof
  verification remain a release gate.
- Require a reachable Redis backend in production and apply fail-closed,
  distributed, HMAC-keyed login, pairing, heartbeat, and manifest budgets.
- Replace shared-secret manifest MACs with Ed25519 signatures verified by the player using a public key pinned during enrollment.
- Revalidate users, memberships, and roles on authenticated requests so disablement or role changes revoke existing tokens immediately.
- Remove device credential verifier hashes from management responses.
- Protect short pairing codes at rest with a deployment-specific HMAC pepper.
- Add audit records for pairing creation and media, playlist, and schedule lifecycle mutations.
- Reject non-HTTPS media locations except explicit loopback development URLs and support an approved-origin allowlist.
- Restrict proxy trust, cap API request bodies at 2 MiB, emit `Cache-Control: no-store` for API responses, disable the Caddy admin endpoint, and add browser security headers.
- Enforce the configured API log level and reject unsafe production origins or reused trust secrets.
- Make container filesystem scanning fail on unresolved HIGH/CRITICAL findings.
- Upgrade Vitest and its coverage provider to the fixed major release, removing the known development-tool path traversal advisory.

### Fixed

- Make Console login and Player pairing keyboard-submittable, restore focus
  after accessible dialogs close, announce operational player states, and clear
  the complete Console session after unauthorized mutations.
- Preserve the last verified normal manifest across repeated emergency polls, early clear, expiry, reboot, and later playback rollback.
- Make emergency manifest versions and durations stable across polling.
- Stop authenticated Console failures from silently displaying demo fleet data.
- Load the Fleet page from the live API and visibly disable unimplemented device commands.
- Clear passwords from Console state after close and every login attempt.
- Make `npm run validate` generate Prisma types so the documented clean-checkout workflow is reproducible.

### Operations

- Replace automatic demo seeding with an explicit one-time bootstrap profile that refuses placeholders and never resets an existing owner password or grants unexpected privileges.
- Add contributor/agent invariants and AI safety context.
- Add explicit NO-GO governance templates for data flows, the non-PII pilot profile, retention/deletion, required approvals, incident response, SLOs, release evidence, and supported-device validation.
- Document the compatibility-oriented design for scoped capabilities, tenant-safe database constraints, immutable releases and approvals, transactional audit/outbox writes, and staged authorization enforcement.
- Add reproducible image-scan, SBOM, release-evidence, PostgreSQL backup/restore,
  object-storage recovery, and retained-image rollback workflows. Evidence is
  explicitly unsigned until protected production signing is implemented.
- Use MinIO's official Quay registry for the pinned server and client images.
- Apply available Debian security updates and remove unused npm/Corepack tooling
  from the final API runtime image.
- Apply available Alpine security updates in the final Console and Player images
  and upload each image's SARIF report under a distinct code-scanning category.
- Make the recovery drill wait for the requested PostgreSQL database instead of
  accepting the image's temporary initialization server as ready.

## 0.1.0 — 2026-09-11

- Initial pre-production prototype with Console, Fastify API, PostgreSQL schema, Docker Compose stack, web/Capacitor player, brand package, CI, and security documentation.
