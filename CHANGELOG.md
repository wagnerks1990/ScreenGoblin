# Changelog

All notable changes are documented here. ScreenGoblin follows semantic versioning once a stable public release exists; `0.x` releases remain prototype interfaces.

## Unreleased

### Security

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

- Preserve the last verified normal manifest across repeated emergency polls, early clear, expiry, reboot, and later playback rollback.
- Make emergency manifest versions and durations stable across polling.
- Stop authenticated Console failures from silently displaying demo fleet data.
- Load the Fleet page from the live API and visibly disable unimplemented device commands.
- Clear passwords from Console state after close and every login attempt.
- Make `npm run validate` generate Prisma types so the documented clean-checkout workflow is reproducible.

### Operations

- Replace automatic demo seeding with an explicit one-time bootstrap profile that refuses placeholders and never resets an existing owner password or grants unexpected privileges.
- Add contributor/agent invariants and AI safety context.

## 0.1.0 — 2026-09-11

- Initial pre-production prototype with Console, Fastify API, PostgreSQL schema, Docker Compose stack, web/Capacitor player, brand package, CI, and security documentation.
