# Changelog

All notable changes are documented here. ScreenGoblin follows semantic versioning once a stable public release exists; `0.x` releases remain prototype interfaces.

## Unreleased

### Security

- Preserve CSP, framing, permissions, referrer, and content-type protections on
  static entry points and immutable assets when location-specific cache headers
  override Nginx header inheritance.
- Enforce signed normal-playback and emergency deadlines with bounded wall-clock
  rechecks, resume checks, and an independent maximum-lifetime countdown so
  forward or backward device clock corrections fail closed.
- Emit a signed whole-release withdrawal when any frozen playlist item fails
  manifest-time URL, origin, credential, media, expiry, checksum, size, or
  aggregate policy, rather than signing an unapproved partial playlist.
- Fail production startup when JWT or pairing secrets reuse documented
  placeholders or checked-in test fixtures, or when manifest signing uses the
  public all-zero test seed. Non-production fixtures remain available only
  outside production.
- Revalidate current `OWNER`/`ADMIN` membership inside pairing-code issuance
  transactions so concurrent demotion, disablement, or tenant removal cannot
  mint enrollment authority; authorization failure leaves pairing and audit
  state unchanged and returns `403` without retrying as a code collision.
- Stream Android binary assets directly into app-private staging files, verify
  exact signed size and SHA-256 incrementally, and atomically publish only
  complete matches. Expose native available-storage telemetry, prune
  unreferenced and orphan files around active/rollback generations, and
  permit only exact-size/hash-verified legacy CacheStorage fallback on an
  explicit native `CACHE_MISS`. Native prefetch/storage failures preserve the
  last-known-good release; physical full-disk and power-loss evidence remains a
  release gate.
- Make screen creation/update and media/playlist creation/deletion atomic with
  their required audit events. Revalidate the actor's active organization role
  inside the same transaction so demotion, disablement, cross-tenant IDs, and
  audit-write failures cannot leave unaudited management mutations.
- Add a real Chromium Console gate against an isolated PostgreSQL-backed API;
  verify owner login, live fleet data, pairing, explicit disconnect, and
  fail-closed session invalidation without demonstration-record substitution.
- Install Debian's exact fixed PCRE2 package in the final API image to remediate
  CVE-2026-86145 and CVE-2026-89161 while the immutable Node base remains pinned.

- Pin every checked-in container build, service, CI, and recovery-fixture image
  to a registry digest; remove floating OS package upgrades from Docker builds;
  and add a validation gate that rejects mutable container inputs.
- Enforce strict SHA-256 verification for Android Maven, plugin, and transitive
  artifacts across CI and CodeQL builds; reject missing metadata, malformed
  checksums, broad trust exemptions, or verification bypasses in the root gate.
- Lock the Android buildscript, app, generated Cordova bridge, and regenerated
  Capacitor Android dependency graphs in strict mode; keep included-build lock
  state in checked-in project paths and reject missing or bypassed locks.
- Upgrade the Android Gradle Plugin to 8.10.1 and force scanner-fixed Netty,
  Protobuf, Bouncy Castle, jose4j, and JDOM versions across root, generated
  buildscript, and Android test-platform graphs; the complete lint, test, debug,
  and release graph must resolve before refreshed locks and verification
  checksums are accepted.
- Add commit-pinned, first-party-blocking CodeQL `security-extended` analysis for
  JavaScript/TypeScript, native Java, and Actions workflows with retained SARIF
  evidence; upgrade generic Trivy SARIF uploads to the same CodeQL Action v4
  pin; and checksum-lock the Gradle 8.11.1 distribution.
- Retain the exact Ed25519 manifest signing bytes in both Player cache slots and
  reverify them against the pinned key and screen before staging, boot recovery,
  or rollback. Remove legacy/altered records, refuse previous-slot revival when
  the active marker is missing, and rehash persistent media before reuse and
  playback.
- Fail production startup when `EMERGENCY_FEATURE_ENABLED=true`; the incomplete
  emergency path remains available only to isolated non-production fixtures and
  cannot be enabled by a production environment override.
- Enroll canonical Android Keystore P-256 public keys through a two-stage,
  transcript-bound pairing challenge; derive installation identity from the
  SPKI fingerprint and require strict domain-separated `ES256-DER` proof before
  atomically creating the screen, credential, and audit event.
- Require short-lived, one-use, operation- and canonical-body-bound device proof
  challenges for manifests and heartbeats. Recheck active credential state when
  consuming proofs, consume heartbeat proof with its mutation transactionally,
  return non-enumerating dummy challenges, and bound live challenges durably.
- Add transactionally authorized, audited, idempotent OWNER/ADMIN device
  credential revocation that invalidates outstanding challenges, and require
  `DEVICE_AUTH_MODE=proof-v1` in production. The legacy bearer path is limited
  to explicit non-production localhost development.
- Add targeted, zero-overlap device re-enrollment that preserves the existing
  screen and assignments: an OWNER/ADMIN request immediately revokes the old
  identity; the Player explicitly rotates to a fresh key and proves a pending
  candidate; and a separate OWNER/ADMIN exact-fingerprint confirmation performs
  an audited, credential-generation-guarded activation. Cancellation,
  superseding grants, revocation races, and competing candidates fail closed.
- Keep hardware/application attestation, automatic overlapping rotation,
  offline recall, verified native erasure, and physical-device validation as
  explicit pilot/release gates. Re-enrollment code-path tests do not close them.
- Require a reachable Redis backend in production and apply fail-closed,
  distributed, HMAC-keyed login, pairing, heartbeat, and manifest budgets.
- Replace shared-secret manifest MACs with Ed25519 signatures verified by the player using a public key pinned during enrollment.
- Revalidate users, memberships, and roles on authenticated requests so disablement or role changes revoke existing tokens immediately.
- Remove device credential verifier hashes from management responses.
- Protect short pairing codes at rest with a deployment-specific HMAC pepper.
- Add audit records for pairing creation and media, playlist, and schedule lifecycle mutations.
- Reject non-HTTPS media locations except explicit loopback development URLs and support an approved-origin allowlist.
- Lock the metadata-only media boundary to pre-provisioned JPEG, PNG, MP4,
  and JSON template assets; disable web media; normalize SHA-256 values; and
  enforce 128 MiB per-asset, 512 MiB per-release, and future-expiry rules at
  both registration and transactional publication boundaries.
- Restrict proxy trust, cap API request bodies at 2 MiB, emit `Cache-Control: no-store` for API responses, disable the Caddy admin endpoint, and add browser security headers.
- Enforce the configured API log level and reject unsafe production origins or reused trust secrets.
- Make container filesystem scanning fail on unresolved HIGH/CRITICAL findings.
- Upgrade Vitest and its coverage provider to the fixed major release, removing the known development-tool path traversal advisory.
- Make pairing-code allocation collision-aware and reusable after expiry while
  keeping issuance, claim, credential creation, and their required audit events
  transactional.
- Bound Player requests, retries, download concurrency, verification memory, and
  retained CacheStorage generations; reject oversized or streaming-overflow
  assets before activation.
- Enforce organization identity through composite PostgreSQL foreign keys for
  playlist assets, schedule playlists/targets, and paired screens, with
  migration preflights that refuse existing cross-tenant relationships.
- Enforce case-insensitive email uniqueness without rewriting conflicting
  accounts, and fail authentication closed if a pre-migration database is
  ambiguous.
- Require an explicit canonical HTTPS media-origin allowlist in production,
  revalidate legacy media before manifest publication, and reject binary asset
  redirects in the Player.
- Publish ordinary schedules, frozen playlist/asset facts, target and time-window
  assignments, and required audit events atomically; validate frozen URLs
  against the exact-origin policy inside the publication transaction.
- Enforce ordinary release publication and withdrawal through a closed,
  deny-by-default capability adapter at both the route and transactional store
  boundaries, including current-membership revalidation.

### Fixed

- Omit the JSON content type from bodyless Console mutations so strict API
  parsing accepts pairing-code creation instead of rejecting an empty JSON body.

- Render Console dialogs through labeled portals, make background application
  content inert, contain keyboard focus, restore the exact opener, and prevent
  modal close controls from implicitly submitting forms.

- Build shared contracts before every API development, build, type-check, and
  test lifecycle so clean workspaces cannot rely on stale generated output.
- Make Console login and Player pairing keyboard-submittable, restore focus
  after accessible dialogs close, announce operational player states, and clear
  the complete Console session after unauthorized mutations.
- Preserve the last verified normal manifest across repeated emergency polls, early clear, expiry, reboot, and later playback rollback.
- Make emergency manifest versions and durations stable across polling.
- Keep normal manifest versions stable across envelope refreshes, emit signed
  withdrawals for absent or unplayable schedules, and enforce signed daily or
  absolute playback boundaries without sacrificing ordinary offline
  last-known-good playback.
- Build ordinary manifests only from immutable release and assignment snapshots;
  schedule withdrawal now appends an audited state event while retaining release
  history, and later source edits cannot rewrite active playback.
- Serialize Player synchronization and make IndexedDB rollback version-conditional
  so stale polls, expiry callbacks, and playback failures cannot overwrite a
  newer release or withdrawal.
- Make Player playback state render-truthful: semantic releases restart cleanly,
  readiness starts item duration and telemetry, stalled or failed renders recover
  once, and late events cannot advance or roll back newer content.
- Isolate the Player service-worker shell cache from API and verified media,
  atomically pre-cache exact build outputs under a content-derived generation,
  and remove only obsolete shell generations during activation.
- Resolve schedule boundaries deterministically across daylight-saving gaps and
  repeated hours: nonexistent boundaries advance to the first valid instant,
  repeated starts use the later occurrence, and repeated ends use the earlier
  occurrence so ended content cannot reactivate.
- Stop authenticated Console failures from silently displaying demo fleet data.
- Make the Media Vault a truthful read-only live inventory, remove simulated
  upload/web creation controls, and never substitute samples after a live API
  failure.
- Load the Fleet page from the live API and visibly disable unimplemented device commands.
- Clear passwords from Console state after close and every login attempt.
- Make `npm run validate` generate Prisma types so the documented clean-checkout workflow is reproducible.

### Operations

- Exercise the complete production-mode Compose stack in CI with ephemeral
  secrets and local TLS. Bound startup, probe API/Console/Player/media routing
  and browser headers through Caddy, verify private service ports and the
  internal backend network, retain redacted failure evidence, and always remove
  disposable containers and volumes. Render the MinIO bootstrap policy using
  only POSIX shell built-ins available in the pinned client image. Preserve the
  API production dependencies in a clean production-only install, copy the
  API workspace's nested modules and generated Prisma client explicitly, and
  fail the build unless imports resolve from the compiled server's directory. Install the pinned
  Bookworm OpenSSL 3 runtime used when generating and executing Prisma.
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
- Exercise PrismaStore against a migrated PostgreSQL service in CI, including
  tenant ID substitution, concurrent pairing, transaction rollback, uniqueness,
  safe BIGINT conversion, and deterministic multi-organization identity lookup.

## 0.1.0 — 2026-09-11

- Initial pre-production prototype with Console, Fastify API, PostgreSQL schema, Docker Compose stack, web/Capacitor player, brand package, CI, and security documentation.
