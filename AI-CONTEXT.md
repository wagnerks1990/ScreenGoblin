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
  recheck that exact session's expiry/revocation and the live user, membership,
  organization, and role. Logout revokes only the presented session and commits
  that change with its audit event; never restore stateless acceptance.
- Enrollment is a two-stage, transcript-bound challenge exchange. Android installation ID equals the server-derived SHA-256 SPKI key ID; an identical successful final claim is idempotently recoverable. A reported Keystore security level is not attestation, and a stolen pairing code remains first-winner authority.
- Device revocation is an OWNER/ADMIN capability revalidated transactionally with the credential/screen change, outstanding-challenge invalidation, and one audit record. Revocation blocks online proof use but cannot recall or erase content from an offline player.
- Targeted re-enrollment is a manual, zero-overlap recovery protocol for an
  existing screen. An authorized request requires an operational reason,
  immediately revokes/detaches the old identity, takes the screen offline, and
  advances a credential generation. An explicit local Player action
  creates a fresh key; proof stages only a pending candidate. A separate current
  OWNER/ADMIN must compare and activate the exact fingerprint. Activation uses a
  generation compare-and-swap, preserves the screen and assignments, creates one
  globally new credential, and cancels competing authority atomically. A code
  alone must never install a replacement, and pairing failure must never cause
  silent key rotation.
- Manifests bind to a screen, carry a renewable envelope lease, and are signed with Ed25519. Every proof-v1 response also signs the one-use request challenge ID, which the Player must match exactly before acceptance. Online activation rejects a signed generation time older than persisted active state and rejects a different semantic version at an equal timestamp; explicit local rollback is exempt. A signed normal withdrawal clears stale playback; an optional signed `playbackEndsAt` is the hard schedule boundary. Players pin the verification key during trusted enrollment, persist the exact verified signing bytes with each cache slot, and reverify the signature, screen binding, and normalized view before boot recovery or rollback. Legacy unsigned or altered slots fail closed, and a missing active slot never promotes an older release.
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
- Tenant-owned database relationships must carry and enforce the same organization ID at the foreign-key boundary; migrations must abort for investigation rather than silently relabel cross-tenant legacy rows.
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

Run `npm run validate`; CI additionally runs the destructive-guarded PostgreSQL integration suite and a four-scenario, single-worker Chromium Console gate against an isolated migrated API database. That browser gate covers real owner login/live fleet/pairing/disconnect, 401 fail-closed behavior without demonstration-record substitution, five representative WCAG 2.1 A/AA axe states, and dialog/skip-link keyboard behavior without retaining traces, screenshots, video, HTML reports, or storage state. CI also boots a uniquely named, production-mode Compose project with ephemeral secrets and local test TLS; it bounds health convergence, exercises API/Console/Player/media ingress and browser headers through Caddy, confirms private service ports and the internal backend network, redacts retained failure diagnostics, and unconditionally removes its disposable volumes. CodeQL runs blocking first-party `security-extended` analysis for JavaScript/TypeScript, Actions workflows, and a traced Android Java debug compilation, retaining complete SARIF artifacts while repository default setup owns Code Scanning uploads. Findings positively located only in installed/generated dependencies remain evidence requiring explicit review or upstream remediation; dependency review separately gates moderate-or-higher vulnerable dependency changes. Unknown or mixed-location CodeQL results fail closed. One documented, source-and-manifest-hash-bound `BootReceiver` false-positive acceptance remains active only while its non-exported exact-action guard is unchanged. GitHub Actions, the Gradle distribution, Android Maven/plugin artifacts and selected dependency graphs, and checked-in container build/service/fixture inputs are commit/checksum/lock/digest-pinned; floating OS package upgrades are prohibited. The Gradle gate requires strict SHA-256 verification metadata, strict project/buildscript lock state, Android Gradle Plugin 8.10.1, and scanner-fixed buildscript transitive pins without broad exemptions, but checksum pinning is not independent publisher provenance. Android identity/proof and native-cache changes also require Gradle lint, host unit tests, and debug/release builds. Continue expanding scoped authorization and immutable release integrity, broader cross-browser/responsive accessibility E2E, Android tests, DNS/egress enforcement, attestation/automatic-rotation/erasure controls, offline/emergency recovery tests, and physical-device evidence as the corresponding features mature. Native cache implementation and host tests do not establish full-disk, process-death, power-loss, reboot-recovery, or telemetry behavior on production hardware. Re-enrollment route, race, and protocol tests do not establish physical fingerprint comparison, device identity, or verified erasure. Tag-triggered release evidence is packaged with normalized tar/gzip metadata,
bound by an adjacent checksum, and attested through a tag-only GitHub OIDC job
that immediately verifies the repository attestation before retaining the final
artifact. Manual dispatches remain unsigned and unprivileged. This provenance
binds the evidence archive digest, not an immutable registry promotion, direct
OCI/APK signatures, production signing custody, or approval. Repository CI also blocks secret and IaC/configuration findings and enforces exact dependency-license policy with narrow, expiring, fail-closed exceptions. Successful static reports and sanitized lockfile-license evidence are checksum-bound; they do not constitute DAST or production-runtime monitoring. Green automated
tests alone do not establish pre-production readiness.
