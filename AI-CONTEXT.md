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
- Manifests bind to a screen, carry a renewable envelope lease, and are signed with Ed25519. A signed normal withdrawal clears stale playback; an optional signed `playbackEndsAt` is the hard schedule boundary. Players pin the verification key during trusted enrollment, persist the exact verified signing bytes with each cache slot, and reverify the signature, screen binding, and normalized view before boot recovery or rollback. Legacy unsigned or altered slots fail closed, and a missing active slot never promotes an older release.
- Player item state is generation-scoped. It reports now-playing and starts the
  display duration only after renderer readiness, blanks stale transitions, and
  invokes bounded single-shot recovery for silent stalls or render failures.
- The production Player build injects exact shell assets into a content-derived
  service-worker cache. API requests and verified manifest media never enter or
  read that shell namespace, and activation prunes shell generations only.
- Non-web assets are bounded, size/hash verified on download, persistent-cache reuse, and playback, and cache-pruned around atomic activation. Emergency overlays never enter the normal rollback chain, and stale callbacks may not roll back a newer active version.
- Live operational data must fail visibly. Never replace a failed authenticated request with demo values.
- Published content, schedules, commands, permissions, emergencies, and device lifecycle operations require durable audit coverage.
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
physical-device validation are not complete release capabilities. Staged
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

Run `npm run validate`; CI additionally runs the destructive-guarded PostgreSQL integration suite. CodeQL runs blocking first-party `security-extended` analysis for JavaScript/TypeScript, Actions workflows, and a traced Android Java debug compilation, retaining complete SARIF artifacts while repository default setup owns Code Scanning uploads. Findings positively located only in installed/generated dependencies remain evidence requiring explicit review or upstream remediation; dependency review separately gates moderate-or-higher vulnerable dependency changes. Unknown or mixed-location CodeQL results fail closed. One documented, source-and-manifest-hash-bound `BootReceiver` false-positive acceptance remains active only while its non-exported exact-action guard is unchanged. GitHub Actions, the Gradle distribution, and checked-in container build/service/fixture inputs are commit/checksum/digest-pinned; floating OS package upgrades are prohibited. Maven/plugin verification remains open. Android identity/proof changes also require Gradle lint, host unit tests, and a debug build. Continue expanding scoped authorization and immutable release integrity, browser accessibility/E2E tests, Android tests, native stream-to-disk caching, DNS/egress enforcement, attestation/automatic-rotation/erasure controls, offline/emergency recovery tests, and physical-device evidence as the corresponding features mature. Re-enrollment route, race, and protocol tests do not establish physical fingerprint comparison, device identity, or verified erasure. Green automated tests alone do not establish pre-production readiness.
