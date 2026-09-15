# ScreenGoblin AI context

## Product intent

ScreenGoblin makes multi-location digital signage simple for schools first while remaining suitable for other organizations. The product model is:

- **Content Studio** — templates, media, playlists, approval, publishing, and accessibility checks.
- **Operations Console** — screens, locations, health, diagnostics, updates, reports, users, and policy.
- **ScreenGoblin Player** — an Android-first, offline-capable, self-recovering playback endpoint.
- **Control plane** — identity, media, schedules, immutable releases, device enrollment, delivery, audit, and integrations.

The explicit scheduling model is: what plays = playlist; where = screen/location/group/tag; when = schedule. Priority order is normal, campaign, priority, emergency.

## Architecture invariants

- Players connect outbound over TLS. In `proof-v1`, Android creates a non-exportable Keystore P-256 identity, the server enrolls its canonical public key, and every manifest or heartbeat requires a fresh operation- and body-bound one-use proof. Production rejects the localhost-only `development-bearer` mode.
- Production must reject documented placeholders and checked-in JWT/pairing
  test secrets, as well as the public all-zero Ed25519 test seed. Test fixtures
  may remain usable only when `NODE_ENV` is explicitly non-production.
- User JWTs are one-hour bearer envelopes around a random, per-login session
  identity whose SHA-256 hash is persisted. Every authenticated request must
  recheck that exact session's expiry/revocation, its user-authentication and
  membership-authorization epoch snapshots, and the live user, membership,
  organization, and role. Password rotation, disablement, role changes, and
  membership removal must use the internal atomic audited store methods; never
  mutate those fields directly or expose an unreviewed administration route.
  Immutable releases and assignments attribute creators through durable
  `(organizationId, userId)` membership-attribution tombstones, so removal can
  revoke live authority without deleting or de-tenant-scoping publication
  history. Tombstones survive membership deletion and cascade only with their
  organization.
  Logout revokes only the presented session and commits that change with its
  audit event; never restore stateless acceptance.
- Failed-login telemetry must cover known and unknown accounts and rate-limit
  rejections without storing raw email, password, or source IP. Use
  deployment-secret, domain-separated HMAC account/source keys and identical
  generic responses. Telemetry persistence fails safe; inserts enforce the
  30-day and 10,000-row bounds. Do not silently downgrade this to best effort.
- Login identity eligibility, including the stable first organization for a
  multi-organization user, must resolve in one fixed store-query shape. Every
  credential check admitted past request validation and rate limiting performs
  exactly one bcrypt comparison; unknown, disabled, and membershipless
  identities use the fixed cost-12 dummy credential. Describe this only as
  reduced timing distinguishability, never as constant-time authentication, and
  never expose membership existence.
- Production initial enrollment starts from a tenant Screen precreated by an
  OWNER/ADMIN and an issuer/epoch-bound grant. The two-stage, transcript-bound
  proof only stages a pending candidate; a current OWNER/ADMIN must activate
  its exact displayed fingerprint before an identical proof retry can recover
  the credential response. Android installation ID equals the server-derived
  SHA-256 SPKI key ID. A code alone cannot mint authority. Fingerprint
  comparison and reported Keystore security level are not attestation,
  physical-device identity, or two-person approval.
- Device revocation is an OWNER/ADMIN capability revalidated transactionally with the credential/screen change, outstanding-challenge invalidation, and one audit record. Revocation blocks online proof use but cannot recall or erase content from an offline player.
- Targeted re-enrollment is a manual, zero-overlap recovery protocol for an
  existing screen. An authorized request requires an operational reason,
  immediately revokes/detaches the old identity, takes the screen offline, and
  advances a credential generation. An explicit local Player action
  creates a fresh key; proof stages only a pending candidate. A separate current
  OWNER/ADMIN must compare and activate the exact fingerprint. Activation uses a
  generation compare-and-swap, preserves the screen and assignments, creates one
  globally new credential, and cancels competing authority atomically. Request,
  revocation, and activation keep the screen offline and clear identity-specific
  heartbeat telemetry; the replacement's first authenticated heartbeat alone
  restores online state. A code
  alone must never install a replacement, and pairing failure must never cause
  silent key rotation.
- Manifests bind to a screen, carry a renewable envelope lease, and are signed with Ed25519. Every proof-v1 response also signs the one-use request challenge ID, which the Player must match exactly before acceptance. Before selection, signing, or private media authorization, the API recomputes the complete frozen published-release and latest-assignment digests; drift fails closed without per-read audit writes, but this does not make a compromised database tamper-proof. Online activation rejects a signed generation time older than persisted active state and rejects a different semantic version at an equal timestamp; explicit local rollback is exempt from generation ordering but must remain within signed playback and asset boundaries. A signed normal withdrawal clears stale playback and atomically tombstones the local rollback slot; an optional signed `playbackEndsAt` is the hard schedule boundary. Players pin the verification key during trusted enrollment, persist the exact verified signing bytes with each cache slot, and reverify the signature, screen binding, normalized view, and local eligibility before boot recovery or rollback. Legacy unsigned or altered slots fail closed, and a missing active slot never promotes an older release.
- Manifest protocol v2 is a strict POST negotiation. Device proof binds canonical
  `{"mediaDelivery":"authorization-v1","protocolVersion":2}`, and the signed
  response repeats it. Ordinary media uses a query-free URL on the exact paired
  API origin/path plus a separate bounded capability sent only as exactly one
  `Authorization: MediaCapability <token>` header. Never add query, GET-manifest,
  v1-token, wrong-scheme, duplicate-header, or downgrade compatibility.
- Verified pre-v2 signed manifests may recover already cached, hash-verified
  bytes only. They must never cause a network fetch. The signed v2 envelope
  stores its opaque media capability in IndexedDB, so do not claim at-rest
  secrecy; external ingress/APM must redact Authorization.
- Private object delivery requires identity encoding and a canonical declared
  length, then independently enforces the signed byte count on the actual API
  stream. Its final byte is withheld until clean upstream EOF; encoded,
  overlong, truncated, and late-error bodies fail closed, and consumer
  cancellation aborts the upstream object stream.
- Player item state is generation-scoped. It reports now-playing and starts the
  display duration only after renderer readiness, blanks stale transitions, and
  invokes bounded single-shot recovery for silent stalls or render failures.
  Heartbeat uptime uses monotonic elapsed time and must not depend on wall-clock
  corrections.
- The production Player build injects exact shell assets into a content-derived
  service-worker cache. API requests and verified manifest media never enter or
  read that shell namespace, and activation prunes shell generations only.
- Android binary assets stream into app-private staging files, are verified
  against exact signed size and SHA-256 while writing, and are atomically
  published only after a complete match. Native available-storage telemetry and
  active/rollback-aware orphan pruning are exposed to the Player. During
  upgrade, an explicit native `CACHE_MISS` may use only an
  exact-size/hash-verified legacy CacheStorage entry; new ordinary Android
  prefetches remain native. Every playable manifest refresh, including an
  unchanged semantic version, revalidates all referenced assets so cache loss or
  corruption is repaired before playback. Browser development
  retains bounded CacheStorage. Emergency overlays never enter the normal
  rollback chain, and stale callbacks may not roll back a newer active version.
- Live operational data must fail visibly. Never replace a failed authenticated request with demo values.
- Published content, schedules, commands, permissions, emergencies, and device lifecycle operations require durable audit coverage.
- Pairing-code issuance revalidates current active `OWNER`/`ADMIN` membership
  inside the code-and-audit transaction before any collision expiry or create;
  authorization loss must return `FORBIDDEN` without retrying or changing state.
- A selected frozen release is emitted only as a complete playlist. If any item
  fails manifest-time policy, sign a withdrawal with no items; never omit the
  failing item and revive the remaining sequence as an unapproved subset.
- Signed playback deadlines must be rechecked on a short wall-clock cadence and
  WebView resume, with an independent original-lifetime countdown; emergency
  expiry blanks synchronously before rollback work. This is not trusted time.
- Screen creation/update and media/playlist creation/deletion revalidate the
  actor's active organization role and commit the resource mutation with its
  audit event in one transaction. Authorization, reference conflicts, and audit
  failures must leave both resource state and audit history unchanged.
- Ordinary schedule publication freezes playlist and asset playback facts plus
  targets and schedule windows in an immutable release assignment. Manifest
  selection must use only those snapshots; withdrawal is append-only and must
  retain release history.
- Ordinary release publication and withdrawal require exact typed capabilities
  and revalidate the actor's current organization membership in the store. The
  current role-to-capability map is only a compatibility adapter; do not treat it
  as scoped authorization or an approval workflow.
- Ordinary publication requires a canonical UUIDv4 command key. Store only its
  domain- and tenant-bound SHA-256 fingerprint and canonical request digest;
  commit the replay body with release, assignment, and audit state. A same-key
  retry is historical response recovery and must never reactivate a withdrawn
  assignment. Thirty-day response bodies compact to non-reusable tombstones.
- Tenant-owned database relationships must carry and enforce the same organization ID at the foreign-key boundary; migrations must abort for investigation rather than silently relabel cross-tenant legacy rows.
- Location is now a stable tenant-bound classification with audited owner/admin
  CRUD and optional Screen linkage. It has no grants or filtering semantics;
  effective authorization remains organization-role-wide, and UI or docs must
  not claim otherwise. The legacy Screen.location label remains compatible.
- Production media must match an explicit canonical HTTPS origin. The current
  metadata-only boundary accepts only pre-provisioned JPEG, PNG, MP4, and JSON
  template assets, disables web content, and enforces 128 MiB per asset and
  512 MiB per release. Direct player delivery still requires controlled DNS and
  egress because hostname allowlisting alone cannot prevent rebinding to private
  addresses.
- Remote shell is not a default capability. Any future implementation needs explicit authorization, consent, scope, expiry, strong audit, and product-level review.

## Deliberately disabled or incomplete

Emergency activation, remote commands, screenshots, proof of play, binary
uploads/scanning/transcoding/private delivery, release approvals, scoped location authorization, MFA/SSO,
update rings, device hardware/application attestation, automatic overlapping
credential rotation, verified local erasure, offline recall, and representative
physical-device validation, including native-cache full-disk, process-death,
power-loss, reboot-recovery, and storage-telemetry evidence, are not complete
release capabilities. Staged
targeted re-enrollment exists as a manual recovery path, but does not imply
attestation, erasure, recall, continuous rotation, or physical-device identity.
Immutable ordinary release snapshots exist, but multi-party approval and
promotion workflows remain incomplete. Do not create UI or documentation that
implies otherwise.

Production configuration must reject `EMERGENCY_FEATURE_ENABLED=true` until the
full emergency acceptance checklist is implemented and evidenced. The
non-production flag exists only for isolated automated fixtures and must not be
treated as an operational escape hatch.

## AI boundaries

AI may draft copy, suggest templates/tags/schedules, summarize device health, and assist diagnosis. A human must approve publishing and device actions. AI may never autonomously publish, operate devices, activate/clear/extend an emergency, make destructive fleet decisions, or perform camera-based demographic inference.

## Quality gate

Runtime-security changes must preserve the disposable production-mode Compose
boundary. CI's digest-pinned ZAP container performs blocking unauthenticated
active scans only through an internal network attached to Caddy, with explicit
method, CORS, error-leakage, and reflection probes and sanitized,
checksum-bound evidence. Public CSP is host-specific: Console is same-origin,
Player adds only the exact configured API origin, and runtime checks reject
wildcard, scheme-wide, localhost-port, inline-style, and frame sources. This
gate also compares a checked-in API method/template inventory to Fastify's
registered public routes, seeds and verifies every fixed route label through
ZAP, hashes unknown finding paths, and hard-limits scanner state to a 256 MiB
tmpfs. This does not cover authenticated or capability-authorized behavior, production
networking/TLS, runtime monitoring, or manual penetration testing.

Run `npm run validate`; CI additionally runs the destructive-guarded PostgreSQL integration suite and a single-worker Chromium Console gate against an isolated migrated API database. That browser gate covers real owner login/live fleet/pairing/disconnect, 401 fail-closed behavior without demonstration-record substitution, five representative WCAG 2.1 A/AA axe states, and dialog/skip-link keyboard behavior without retaining traces, screenshots, video, HTML reports, or storage state. CI also boots a uniquely named, production-mode Compose project with ephemeral secrets and local test TLS; it bounds health convergence, exercises API/Console/Player/media ingress and browser headers through Caddy, confirms private service ports and the internal backend network, redacts retained failure diagnostics, and unconditionally removes its disposable volumes. CodeQL runs blocking first-party `security-extended` analysis for JavaScript/TypeScript, Actions workflows, and a traced Android Java debug compilation, retaining complete SARIF artifacts while repository default setup owns Code Scanning uploads. Findings positively located only in installed/generated dependencies remain evidence requiring explicit review or upstream remediation; dependency review separately gates moderate-or-higher vulnerable dependency changes. Unknown or mixed-location CodeQL results fail closed. One documented, source-and-manifest-hash-bound `BootReceiver` false-positive acceptance remains active only while its non-exported exact-action guard is unchanged. GitHub Actions, the Gradle distribution, Android Maven/plugin artifacts and selected dependency graphs, and checked-in container build/service/fixture inputs are commit/checksum/lock/digest-pinned; floating OS package upgrades are prohibited. The Gradle gate requires strict SHA-256 verification metadata, strict project/buildscript lock state, Android Gradle Plugin 8.10.1, and scanner-fixed buildscript transitive pins without broad exemptions, but checksum pinning is not independent publisher provenance. Android identity/proof and native-cache changes also require Gradle lint, host unit tests, and debug/release builds. Continue expanding scoped authorization and immutable release integrity, broader cross-browser/responsive accessibility E2E, Android tests, DNS/egress enforcement, attestation/automatic-rotation/erasure controls, offline/emergency recovery tests, and physical-device evidence as the corresponding features mature. Native cache implementation and host tests do not establish full-disk, process-death, power-loss, reboot-recovery, or telemetry behavior on production hardware. Re-enrollment route, race, and protocol tests do not establish physical fingerprint comparison, device identity, or verified erasure. Tag-triggered release evidence is packaged with normalized tar/gzip metadata,
bound by an adjacent checksum, and attested through a tag-only GitHub OIDC job
that immediately verifies the repository attestation before retaining the final
artifact. Manual dispatches remain unsigned and unprivileged. This provenance
binds the evidence archive digest, not an immutable registry promotion, direct
OCI/APK signatures, production signing custody, or approval. Repository CI also blocks secret and IaC/configuration findings and enforces exact dependency-license policy with narrow, expiring, fail-closed exceptions. Successful static reports and sanitized lockfile-license evidence are checksum-bound; they do not constitute DAST or production-runtime monitoring. Green automated
tests alone do not establish pre-production readiness.
