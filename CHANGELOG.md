# Changelog

All notable changes are documented here. ScreenGoblin follows semantic versioning once a stable public release exists; `0.x` releases remain prototype interfaces.

## Unreleased

- Validate the manifest packaged inside the assembled Android release APK
  against a fail-closed exact policy for package/SDK identity, permissions,
  optional features, application security flags, and exported/non-exported
  components. Allow only the package-derived AndroidX signature permission and
  non-exported Startup provider with lifecycle and emoji initializers; remove
  the ProfileInstaller initializer/receiver and DUMP permission from the final
  package. Retain a schema-versioned summary recording analyzer version plus the
  inspected APK and packaged-manifest SHA-256 values, with a one-day
  manifest-only diagnostic on failure. This static release-surface evidence
  does not provide APK signing or provenance, OWASP MASVS compliance, runtime
  analysis, or physical-device validation; those release gates remain open.

- Make Player heartbeat scheduling fleet-safe with an immediate first send for
  a newly activated credential, phase-spread process restarts, one recursive
  single-flight timeout, strict 5-second-to-one-day server
  cadence acceptance, bounded plus-or-minus-10% cadence jitter, and coalesced
  reconnect/visibility/page-resume catch-up uniformly within the current
  interval without postponing an earlier healthy send. Retryable failures use bounded exponential backoff with
  `Retry-After` as a floor; non-retryable protocol failures retain the current
  cadence. Every attempt rebuilds current telemetry and obtains fresh one-use
  proof instead of replaying a heartbeat. Representative Android
  suspend/resume evidence remains an open pre-production fleet gate.

- Separate the protected PostgreSQL migration/schema owner from the non-owning
  API runtime identity. Reconcile runtime role attributes and exact object/default
  privileges after migrations; run the API, bootstrap seed, and offline recovery
  without schema-owner authority. Checksum-bound `--no-owner --no-acl` restores
  now reapply that reconciliation and validate allowed application reads/writes
  plus denied migration-ledger, truncation, and DDL access before succeeding.
  Migration, PostgreSQL-superuser, managed-service administrator, secret-custody,
  and real-environment recovery risks remain explicit pre-production gates.

- Contain deployment-seeded owner passwords with a database-time 24-hour
  first-use deadline and purpose-limited rotation sessions that cannot access
  operational APIs. The blocking Console flow requires a different password of
  at least 16 Unicode code points and at most 72 UTF-8 bytes. One atomic change
  clears the marker, advances the authentication epoch, revokes every user
  session and pending enrollment authority across memberships, and appends a
  tenant audit event for each membership; the user must then sign in again.
  Existing matching seed owners are contained once without silently resetting
  their password, reruns cannot extend the deadline, and expired credentials
  fail closed into an acknowledged offline recovery command that issues a
  separately audited 30-minute temporary credential and repeats the global
  revocation boundary. This does not add SSO, MFA, general self-service password
  changes, dual-control recovery, or production readiness.

- Fail production startup on wildcard, opaque, malformed, credentialed,
  path-bearing, insecure network, local/private, or arbitrary custom-scheme
  CORS origins. Canonical exact origins are bounded and deduplicated, while the
  two native Player origins remain explicit exceptions; application startup
  also rejects unsafe programmatic CORS options.

- Keep the deployment environment template aligned with every required Compose
  input, including an independent private-media delivery secret, and make the
  Console release-evidence test portable across host time zones.

- Add a bounded, non-authoritative scoped-access comparison for successful,
  non-replayed release-candidate creation. It uses the locked current
  membership, database time, server-resolved screen classifications, and
  persisted grants inside the mutation transaction, then stores only sanitized
  evidence in the existing audit event. Legacy authorization remains the sole
  decision; the database remains latched to `LEGACY`.

- Add an idempotent, exact-membership compatibility-grant backfill with
  explicit system provenance, bounded deterministic identifiers, role-change
  rebundling, and no bootstrap epoch/session changes. The database remains
  latched to `LEGACY`, and request-time grant loading/enforcement remains off.
- Order logout principal and session locks consistently with membership
  mutation so concurrent logout and removal complete without a database
  deadlock while retaining transactional revocation and audit evidence.

- Add the deny-by-default scoped-authorization schema and pure policy
  foundation: tenant-bound flat screen groups, exact organization/location/
  group/screen grant shapes, a closed non-emergency capability vocabulary,
  role ceilings, all-target evaluation, and deterministic scope evidence. A
  database safety latch keeps every organization in `LEGACY` mode; grants are
  not enforced yet, and this does not complete the scoped-access
  release gate.

- Replace direct ordinary schedule publication with an immutable four-step
  release-candidate workflow: create, submit, independently approve, and
  publish. Candidate content, schedule, and organization-wide target snapshots
  are digest-bound for at most seven days; only an `OWNER`/`ADMIN` distinct from
  the author may approve, while the publisher may be either participant. Every
  successful
  transition and its canonical idempotency replay snapshot commits
  transactionally, unexpired non-published candidates are capped at 100 and all
  retained non-published candidates at 1,000 per organization, and expired
  never-published candidates older than the 30-day replay window are
  garbage-collected in bounded batches. Existing assignments remain
  grandfathered; this is a coordinated-downtime, no-old-binary-rollback
  migration and does not enable emergencies,
  scoped grants, or complete the pre-production approval gate.
- Fix the release-assignment provenance gate with an exact, atomic provenance
  triangle and bind each approved assignment to its expected withdrawal digest
  so a forged successor cannot consume the unique withdrawal-history slot.
  Approved publication pre-generates assignment and publication IDs;
  deferred composite foreign keys require both the final `ASSIGNED` row and
  `PUBLISHED` candidate to point to the same publication evidence at commit.
  Recovery verifies those constraints and rejects partial graphs.

- Remove emergency activation and clear authority from every legacy role bundle;
  production startup containment remains in place, and forcing the fixture flag
  does not give any current role effective emergency authority. Remove the
  deprecated caller-supplied media metadata registration route and its
  configuration switch entirely. Runtime, API, route-inventory, and static
  guards keep registration, multipart/media-ingestion, parser, and
  caller-directed remote-fetch surfaces absent. This containment does not
  implement the emergency workflow or private ingestion pipeline and does not
  complete either pre-production gate.

- Replace URL-carried private-media credentials with a strict protocol-v2
  contract. Manifest POST negotiation is device-proof-bound; signed manifests
  contain query-free same-origin API URLs and separate capabilities used only
  with the exact `MediaCapability` Authorization scheme. The API rejects GET,
  query, v1, malformed, missing, duplicate, and wrong-scheme transports without
  storage access; browser and Android downloads preserve exact byte/hash,
  bounded-stream, offline LKG, and rollback behavior. Verified pre-v2 records
  are cache-only during upgrade, never a legacy network fallback.

- Preserve tenant-scoped creator provenance for immutable releases and
  assignments after membership removal. A transactional migration backfills
  guarded membership-attribution tombstones, records future memberships in the
  same database transaction, and repoints composite creator foreign keys so
  access revocation cannot be blocked by retained publication history.

### Security

- Bound persistent proof-challenge history with database-clock, lock-skipping
  pruning during successful issuance, preserving every live challenge. Compact
  bounded batches of expired schedule-publication response bodies during
  successful authorized publication while retaining permanent idempotency tombstones and
  transactional rollback. Document checksum-safe verification and manual
  recovery for interrupted historical nontransactional migrations; no
  scheduled maintenance or automatic migration repair is claimed.

- Require identity-encoded private object responses and enforce the signed byte
  length against the bytes actually streamed through the API. Encoded,
  overlong, truncated, missing-length, and malformed-length responses fail
  closed; the final byte is released only after a clean upstream EOF so a late
  extra chunk or error cannot complete the declared HTTP response. Downstream
  disconnects abort the upstream object stream.

- Validate schedule absolute windows by parsed instants and canonicalize
  accepted timestamps to millisecond UTC before persistence, immutable
  assignment hashing, idempotency replay, and management responses. Startup
  validation now identifies invalid media-origin entries only by position and
  never echoes their raw URL, credentials, query, or private hostname.

- Replace proof-v1's unbound, first-winner initial pairing authority with
  precreated tenant screens, issuer membership/epoch-bound grants, candidate-only
  device proof, and explicit exact-fingerprint OWNER/ADMIN activation. Creation
  and activation are idempotently replayable without plaintext code storage;
  one serializable winner revokes competitors and remains offline until an
  authenticated heartbeat. Identity lifecycle changes revoke both initial and
  replacement grants, including concurrent replacement proof. Manual
  fingerprint comparison is not attestation, physical identity, two-person
  approval, MFA, or location-scoped authorization.

- Preserve an active owner for every tenant when internal identity lifecycle
  helpers disable a user, demote an owner, or remove an owner membership.
  PostgreSQL serializes competing owner changes per tenant; rejected changes
  leave membership, session, identity, and audit state unchanged. Public
  identity-administration and ownership-transfer APIs remain unimplemented.

- Bound local `AuditEvent` scalar and structured metadata fields, reject
  ordinary PostgreSQL row updates and direct deletes while preserving existing
  user-attribution nulling and tenant deletion cascades, and make in-memory and
  PostgreSQL latest-event ordering deterministic. These database-owner-bypassable
  guardrails are not tamper evidence, WORM storage, an export pipeline, or a
  retention/legal-hold implementation.

- Recompute immutable published-release and latest-assignment digests from their
  complete frozen snapshots before manifest selection or private media
  authorization. Drift now fails closed without re-signing the altered state or
  creating attacker-amplifiable audit events on every read.

- Treat an accepted signed withdrawal as a Player rollback tombstone: remove the
  previous manifest atomically, repair legacy tombstone state on reboot, and
  reject rollback across withdrawn, corrupt, or expired playback/asset state.
  This prevents a later playback failure from reviving content the Player has
  already withdrawn without claiming recall of bytes on disconnected Players.

- Stage a native-only Android command journal for exactly `REFRESH_CONTENT` and
  `RESTART_RENDERER`. Persist lexicographic credential-generation/sequence,
  command identity, explicit renderer-ready lifecycle, and terminal
  acknowledgement state with process-wide in-process serialization. Higher
  credential generations supersede all older-generation state, while an
  uncertain preference commit poisons the journal until process restart;
  reject corrupt state, rollback, conflicting replay, and every other action.
  The plugin is not registered with the Capacitor bridge, and no server,
  manifest, heartbeat, Player JavaScript, or Console path can invoke it, so
  remote commands and emergency operation remain disabled.

- Cap private media delivery at the earliest manifest lease, frozen schedule
  playback boundary, or frozen asset expiry. Bind capabilities to the immutable
  assignment ID/digest and recheck the tenant/screen-specific latest assignment
  before storage access so withdrawal or replacement revokes subsequent online
  reads immediately without resource-existence disclosure.

- Reduce account-existence timing distinguishability by resolving active,
  unknown, disabled, and membershipless login identities with one fixed SQL
  statement and performing exactly one bcrypt comparison for each. Ineligible
  identities use a supported fixed cost-12 dummy credential; generic failure
  telemetry and stable first-organization login semantics remain unchanged.
  This is not a constant-time authentication claim.

- Remove deprecated caller-supplied media metadata registration and its
  configuration switch. Document the separate durable quarantine,
  fail-closed malware scanning, canonicalization, atomic-visibility promotion,
  cleanup/retry, and safe image/video derivative design without claiming that
  upload or external scanning/transcoding is implemented.

- Bind each one-hour user session to immutable user-authentication and
  membership-authorization epoch snapshots. Internal password rotation,
  disablement, role change, and membership removal helpers now advance the
  applicable epoch, revoke affected sessions, and append tenant audit records
  atomically, so restoring an old role cannot revive an old session. The Console
  now attempts `POST /auth/logout` before clearing tab credentials and warns when
  server revocation cannot be confirmed. Public identity-administration APIs,
  external SSO, and MFA remain absent requirements.

- Upgrade the Android Google Services Gradle plugin to 4.5.0 with its exact
  buildscript lock and strict artifact verification checksums. Retain the
  checksum-locked Gradle 8.11.1 wrapper paired with Android Gradle Plugin 8.10.1;
  a Gradle 9 migration remains a separate Android toolchain change.

- Add a blocking unauthenticated runtime-security gate to the production-mode
  Compose exercise. A digest-pinned ZAP 2.17.0 container runs active scans from
  an internal network connected only to Caddy, while explicit probes reject
  unsafe TRACE handling, untrusted CORS reflection, error-detail leakage, and
  executable payload reflection. Retained evidence is sanitized,
  deterministically ordered, checksum-bound, and immediately verified. This
  does not cover authenticated workflows, capability-authorized private media,
  production TLS/network controls, or manual penetration testing.
  Host-specific Caddy policies restrict Console connections to the same origin
  and Player connections to the exact configured API origin; scheme-wide,
  wildcard, localhost-port, inline-style, and frame sources are rejected by
  runtime probes. Dynamic dashboard and emergency-template presentation now
  use CSP-compatible SVG attributes instead of inline styles.
  Seed the full registered public API method/template inventory into ZAP before
  the recursive active scan and fail on route/inventory or observed-coverage
  drift. Scanner state is hard-limited to a 256 MiB non-root tmpfs. Retained
  finding locations use only fixed route labels or SHA-256 path digests, never
  raw URI paths.
  Retain every alert in ZAP's complete JSON report, including IDs the packaged
  wrapper excludes from its own exit-status calculation, and independently
  block every Low, Medium, or High alert. Informational scanner observations
  remain explicit evidence instead of rule-ID suppressions. Treat wrapper
  finding exits 1/2 as advisory only after exact report/coverage validation;
  operational exits, timeouts, signals, unexpected statuses, and malformed
  evidence remain blocking.

- Replace anonymous object-storage delivery with short-lived API capabilities bound to the active device, tenant, immutable asset identity, server-derived storage key, digest, size, method, and manifest lease. The API streams only from its fixed private S3 endpoint; direct Caddy/MinIO media access is removed. Populated legacy media upgrades now abort before mutation unless operators first complete an explicit object copy and checksum/size verification runbook; management DTOs do not expose private storage keys.

- Upgrade the ESLint toolchain to ESLint 10 with matching core, React Hooks,
  React Refresh, and globals packages, and upgrade the DOM matcher package to
  its Node 22-compatible release. Preserve the reviewed Rules of Hooks and
  exhaustive-dependency policy explicitly instead of silently enabling the
  React Compiler rule set.

- Add authoritative, privacy-preserving failed-login telemetry for known and
  unknown accounts and rate-limit rejections. Store only domain-separated HMAC
  account/source keys, bounded reasons, and server time; keep credential
  responses indistinguishable. Telemetry persistence fails safe, while
  insertion-triggered pruning enforces a 30-day and 10,000-row bound.

- Add blocking, checksum-verified repository secret and IaC/configuration scans plus an exact dependency-license policy. Require every non-link lock entry to have exact identity/version/license; validate HTTPS, file, and git locators, inherit only exact package-version provenance, and explicitly inventory entries whose lockfile locator is absent. Reject broad, stale, malformed, or unused exceptions; retain successful sanitized SARIF/license evidence with a verified checksum manifest. These static controls do not provide DAST or production-runtime coverage.

- Require `PUBLIC_API_URL` to be a canonical credential-free HTTPS origin
  in production, normalize it before constructing the paired device API base,
  and reject path, query, or fragment configuration before a pairing code can
  be consumed into an unusable Player endpoint.
- Replace eight-hour stateless user tokens with one-hour, individually tracked
  sessions. Store only hashes of random session identities, recheck
  expiry/revocation and current membership on every authenticated request, and
  make current-session logout atomic with its audit event. Later logins prune
  expired rows without revoking a user's other active sessions.

- Bind every proof-v1 manifest signature to the one-use challenge consumed for
  its request, require the Player to verify that exact response binding, and
  reject online activation of an envelope older than persisted active state or
  a different semantic version with an equal generation timestamp.
  Explicit rollback and offline playback through signed hard deadlines remain
  unchanged.
- Make isolated-fixture emergency activation and clear atomic with their
  immutable audit events. Revalidate the actor's current capability and lock
  every organization-scoped target inside the same transaction so demotion,
  cross-tenant targets, and audit-write failures fail without partial state.
  Production emergency publishing remains hard-disabled; two-person approval,
  step-up MFA, delivery acknowledgement, recovery, and tabletop gates remain
  incomplete.

- Package release evidence with normalized tar metadata and a verified checksum.
  For protected `v*` tag events only, bind that archive digest to GitHub OIDC
  build provenance and verify the attestation before publishing the retained
  artifact; manual workflow runs remain explicitly unsigned.

- Derive heartbeat uptime from a monotonic elapsed-time clock so wall-clock
  rollback cannot create invalid negative telemetry, and reverify every cached
  asset during same-release manifest refreshes so evicted or corrupt future
  playlist items are repaired before playback.
- Ignore caller-supplied request IDs and generate server-owned UUIDs for error,
  log, and immutable audit correlation so clients cannot create collisions.
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
- Fail production startup when `EMERGENCY_FEATURE_ENABLED=true`; retain only
  isolated non-production transactional fixtures while granting no legacy role
  activation or clear authority.
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

### Changed

- Keep revoked and replacement device identities operationally offline, clear
  detached heartbeat/playback telemetry, and require the activated credential's
  first authenticated heartbeat before reporting online. Backfill reliably
  identifiable stale revoked and never-heartbeaten replacement rows, and
  revalidate Memory proof state after asynchronous signature verification.
  Schedule reads now
  exclude records whose deterministic latest assignment is withdrawn while
  retaining immutable publication history.

- Require tenant-bound UUIDv4 idempotency keys for ordinary schedule
  publication. A lost successful response now replays the original schedule
  without reactivating content after withdrawal; actor or payload reuse
  conflicts, fresh keys preserve deliberate republication, and 30-day response
  records compact to permanent command tombstones.

- Upgrade the API's direct `fastify-plugin` dependency to 6.0.0. The existing
  default-import registration contract remains covered by API type, unit,
  integration, and production-build gates.
- Run the recovery drill automatically for root lockfile pull-request changes
  so dependency candidates receive recovery evidence for their exact head.

### Fixed

- Make the Console Dashboard issue counts and explanations derive from one
  screen-list response, distinguish loading, failure, successful empty, live,
  and demonstration states, and provide a working refresh/retry without
  presenting unavailable screenshots or activity as operational telemetry.

- Make the prototype Settings page explicitly read-only. Remove editable
  workspace defaults, content-approval and proof-of-play toggles, and the false
  save affordance so the Console does not imply that unavailable governance or
  playback-verification controls are persisted or enforced.

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

- Add tenant-bound Location classifications with audited owner/admin CRUD,
  preserve legacy screen location labels, and backfill existing labels without
  changing organization-role authorization. Per-user location grants and
  resource filtering remain explicitly unimplemented.

- Upgrade the disposable recovery drill from a synthetic row/object probe to
  the complete Prisma migration chain and a representative restored application
  relation graph whose live and frozen media metadata is bound to independently
  restored MinIO bytes. Retain checksum-bound elapsed CI measurements while
  explicitly excluding production RPO/RTO claims and real-environment recovery
  coverage.

- Exercise the complete production-mode Compose stack in CI with ephemeral
  secrets and local TLS. Bound startup, probe API/Console/Player/media routing
  and browser headers through Caddy, verify private service ports and the
  internal backend network, inspect actual Docker host-port bindings, retain
  redacted failure evidence, and always remove
  disposable containers and volumes. Render the MinIO bootstrap policy using
  only POSIX shell built-ins available in the pinned client image. Require a
  nonempty ACME account contact so Caddy configuration cannot render an invalid
  empty email directive, and make the public readiness denial an ordered
  terminal route that cannot fall through to the Console. Preserve the
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
