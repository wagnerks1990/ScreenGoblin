# Threat model

## Scope and assets

This model covers the console, API, database, object storage, reverse proxy, and Android-oriented players. The most important assets are publishing authority, emergency controls, device credentials, user sessions, tenant data, media integrity, audit history, and display availability.

ScreenGoblin is not currently a certified emergency-notification or life-safety system.

## Trust boundaries

- User browser to public reverse proxy/API.
- API to PostgreSQL, Redis, and object storage on the private container network.
- Untrusted player networks to the public API and media endpoint.
- CI and administrators to deployment infrastructure and signing secrets.
- Uploaded content crossing into object storage and player renderers.

## Principal threats and controls

| Threat                                          | Impact                                                                | Required control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential/key theft                            | Account/device takeover                                               | MFA/SSO before production and short user sessions. Production devices use a unique enrolled P-256 public-key credential, Android Keystore non-exportable private key, short-lived one-use operation proofs, transactional revocation, and header/log redaction. Targeted recovery immediately revokes the old identity and requires a later current-authority exact-fingerprint activation. Hardware attestation, automatic overlapping rotation, and verified erasure remain gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cross-tenant access                             | Data or screen compromise                                             | Organization scoping in every query, negative authorization tests, server-generated object keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Publication retry replay                        | A lost response retried after withdrawal silently reactivates content | Required canonical UUIDv4 command keys, tenant/domain-bound SHA-256 fingerprints, canonical request digests, live actor authorization revalidation, and one transaction for publication, audit, and replay state. Same-command retries return the historical response without writing assignments; actor/payload reuse conflicts. Full responses expire after 30 days; each successful authorized publication compacts a bounded batch, while durable non-reusable tombstones remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Pairing-code guessing/theft                     | Rogue device enrollment                                               | Production grants bind a precreated tenant screen and issuer membership/epoch snapshots. Short expiry, collision-safe allocation, HMAC protection at rest, source/code/operator/tenant rate limits, bounded candidates, and transcript-bound P-256 proof apply. A stolen code can only stage a candidate; a current OWNER/ADMIN must activate its exact fingerprint before a credential exists. This manual comparison is not physical-device identity or hardware/application attestation.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Device-proof replay                             | Forged heartbeat/content access                                       | Random 30-second pairing and 45-second operation challenges stored only as hashes, fixed operation and canonical body-digest binding, strict domain-separated P-256 signatures, active credential recheck, and atomic one-use consumption. Invalid signatures do not consume a challenge; valid proofs cannot be replayed. Successful issuance prunes at most 100 rows whose expiry is at least 24 hours old using the database clock and lock-skipping concurrency; live challenges are never maintenance targets.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Revoked/offline player                          | Continued stale playback                                              | OWNER/ADMIN transactional revocation invalidates online proofs, outstanding challenges, and stale re-enrollment grants. Revocation cannot reach a disconnected player, erase cached media, or override signed local playback boundaries; network containment, physical recovery, and verified native erasure remain required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Re-enrollment race/substitution                 | Unauthorized replacement or restored revoked access                   | A targeted grant binds one tenant screen and captured credential generation. Request atomically revokes/detaches the prior identity. Fresh-key proof creates only a pending candidate; a later current OWNER/ADMIN action must activate its exact fingerprint. Replacement clears the detached identity's operational telemetry and remains offline until the new credential's authenticated heartbeat. Generation compare-and-swap, cancellation, globally unique key IDs, ordered locks, and one-live-credential constraints reject stale grants, competing candidates, revoke races, and prior-key reuse. This does not establish physical-device identity or two-person approval.                                                                                                                                                                                                                                                                   |
| Manifest or media tampering                     | Unapproved display content                                            | TLS, server-side recomputation of complete frozen release/latest-assignment digests before selection, signing, and media authorization, exact manifest signing bytes retained and reverified with the pinned key/screen on boot and rollback, normalized-view equality, native app-private stream-to-disk size/SHA-256 verification, atomic file publication, verified legacy-cache fallback, and fail-closed activation. Digest mismatches do not emit per-read audit rows; external database-integrity and repeated-withdrawal/404 monitoring is required. These unkeyed digests do not make a compromised database tamper-proof. A privileged local attacker may still replay an older valid signed envelope; rollback-resistant native state and physical power-loss evidence remain gates.                                                                                                                                                         |
| Withdrawn rollback resurrection                 | Explicitly withdrawn content returns after a later playback failure   | A signed withdrawal is an active local tombstone that atomically deletes the rollback slot. Recovery repairs legacy tombstone state, and rollback validates both signed slots plus playback/asset deadlines before any state swap. A Player that never receives the withdrawal can still use already-downloaded bytes within their signed hard boundaries; server-side recall and rollback-resistant hardware storage remain separate gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Player clock correction                         | Expired scheduled or emergency content remains visible                | Signed hard deadlines are rechecked against wall time at least every 30 seconds and on WebView resume. An independent countdown prevents a backward correction from extending the lifetime calculated when the current playback session begins, and emergency content blanks before rollback work. This is not trusted time: incorrect initial clocks and device-specific sleep/firmware behavior still require managed time synchronization and physical-device evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Player storage exhaustion                       | Failed updates or playback availability                               | Native available-storage telemetry, bounded signed release sizes, synchronized reservations, app-private staging, cleanup on failure, and active/rollback-aware orphan pruning. A prefetch capacity or I/O failure preserves last-known-good playback. Representative low-space/full-disk, process-death, reboot, and power-loss tests on production filesystems remain pre-production gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Malicious upload                                | Player/browser compromise                                             | Browser upload and web media are disabled. The metadata-only pilot boundary restricts exact MIME/kind pairs and sizes, but it does not fetch, sniff, scan, decode, or transcode pre-provisioned objects; a private quarantine/scanning/transcoding pipeline remains a pre-production gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Stored XSS/template injection                   | Admin session compromise                                              | Web content is disabled. JSON templates are schema/length/color validated and rendered as text without arbitrary markup or scripts; browser CSP remains defense in depth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| URL content and redirect abuse                  | Player-network/internal access                                        | Production requires an explicit exact-origin HTTPS allowlist with public DNS hostnames; credentialed URLs and binary download redirects are rejected, and web media is disabled. The API does not fetch media. The native bridge bypasses WebView CORS and accepts HTTPS, so honest calls still depend on signed manifests and server origin validation; a compromised WebView requires VLAN egress enforcement or a fetch proxy. DNS rebinding and private-address resolution remain deployment/pre-production gates.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Emergency misuse                                | Panic or unsafe instruction                                           | Separate permission, clear scope/expiry, re-authentication and two-person approval in production, immutable audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Direct or self-approved ordinary publication    | One actor bypasses review or mutable content reaches screens          | Direct schedule publication is a `410` tombstone. Immutable, digest-bound candidates require author submission and approval by a different active `OWNER`/`ADMIN` before transactional publication; `PUBLISHER` cannot approve. Publication revalidates approval epochs, authority, release/assets, target snapshot, and expiry. PostgreSQL rejects new unapproved `ASSIGNED` rows, while deferred composite foreign keys require the final assignment and published candidate to link to the same exact publication evidence at commit. Each approved assignment immutably binds its expected withdrawal digest, and a deferred guard requires the withdrawal digest, scalar snapshot, and target set to match before commit so a forged successor cannot consume its unique history slot. The publisher may equal the author or approver, so this provides two-person author/approver separation, not three-person separation, scoped grants, or MFA. |
| Candidate/replay exhaustion or reinterpretation | Stale intent is published or tenant storage is exhausted              | Candidates expire within seven days, each organization is capped at 100 unexpired and 1,000 retained non-published records, and creation performs bounded GC of expired never-published candidates only after the 30-day replay window. Each operation stores a canonical idempotency response snapshot for historical replay; changed actors/payloads and expired/compacted keys fail closed. Published evidence is retained; pruning preserves audit and idempotency tombstones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Replay/forged commands                          | Fleet disruption                                                      | Commands disabled in prototype; require signed expiring IDs, replay cache, authorization, and allowlisted handlers before enablement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Denial of service                               | Console/API/player outage                                             | Request/body limits, rate limits, bounded retries/timeouts/download concurrency and verification memory, cache retention, cached playback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Dependency/build compromise                     | Supply-chain execution                                                | lockfile, protected branches, dependency review, CodeQL, secret scan, image scan, signed artifacts/SBOM before production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Database/object loss                            | Lost schedules/media/audit                                            | Encrypted versioned backups, restore drills, retention and off-host copies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Local audit row mutation                        | Incomplete or misleading local history                                | Bounded scalar/JSON fields and a PostgreSQL trigger reject ordinary row updates and direct deletes while preserving current user and tenant deletion semantics. The API currently uses the table-owning login, which can disable the trigger or truncate/rewrite the table. There is no hash chain, independently protected anchor, outbox/export monitor, approved retention job, or legal hold, so these controls address application mistakes rather than a compromised database or administrator.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Screenshot privacy leak                         | Unintended personal data                                              | Role-gate, audit, short retention, encryption, disable per location where required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The Android application now contains a native-only staged command journal for
the exact non-shell actions `REFRESH_CONTENT` and `RESTART_RENDERER`. It stores
credential generation, per-generation monotonic sequence, command identity,
accepting renderer lifecycle, execution state, and pending terminal
acknowledgement in dedicated app-private preferences. Process-wide serialization
protects its in-process read/validate/replace transition, and malformed state,
lexicographic rollback, conflicting replay, or unsupported actions fail closed.
A higher credential generation atomically supersedes older-generation pending
work and terminal acknowledgement state while starting a new sequence domain.
A restart remains pending until a different renderer lifecycle reports ready
through a package-private native hook; bridge JavaScript cannot assert readiness,
and construction, reload, or reboot does not itself report success. That trusted
native lifecycle integration is not implemented in this unreachable stage.
The plugin is deliberately not registered with the Capacitor bridge; no API
route, manifest/heartbeat field, Player JavaScript caller, or Console control can
deliver a command, so remote commands remain disabled. Preference commit success
is only an Android API-level persistence result: this repository does not claim
physical power-loss durability, encrypted or hardware-backed state, protection
from privileged storage rollback, or survival after application data is cleared.
If a preference replace returns false or throws, the outcome is uncertain because
Android's in-memory map may already have changed. The storage namespace is then
poisoned for the process lifetime, and all later operations return
`STATE_UNCERTAIN` without reading it. Restarting the process clears only that
in-memory poison: exact valid stored state is used and malformed state fails
closed. Manually clearing application data is a destructive reset that erases
the replay high-water state and does not unpoison an already-running process.
Authorization, immutable server records, signed proof-bound delivery, expiry,
audit, capability negotiation, authenticated acknowledgement, trusted native
readiness integration, and representative device lifecycle/power-loss testing
remain required before enablement. OS reboot, cache clearing, screenshots,
updates, emergency actions, and arbitrary or shell execution are not represented.

The repository supply-chain gate now uses the checksum-verified Trivy binary
for blocking secret and infrastructure/configuration scans and enforces an
exact lockfile-license allowlist with narrow, expiring exceptions. These are
static repository and build-input controls; they do not monitor production
runtime configuration.

The production-mode Compose CI exercise adds bounded unauthenticated DAST for
the public Caddy Console/API and Player origins. A digest-pinned ZAP active
scanner runs without capabilities or an external network route, and explicit
probes cover unsafe method handling, hostile CORS reflection, malformed-request
error leakage, executable reflection, and host-specific CSP without wildcard or
scheme-wide sources or inline styles. The Player's only additional connection
source is the exact configured Console/API origin used for its signed
private-media requests. Fastify route-registration drift, missing pre-scan ZAP
API seeds, wrong/empty report sites, and scanner tmpfs/file-budget exhaustion
also fail closed. Scanner errors and every Low, Medium, or High JSON report
alert fail closed independently of the packaged wrapper's status. All
Informational observations, including rule IDs the wrapper excludes, remain in
the checksum-bound sanitized summary and are counted separately rather than
suppressed. Wrapper finding statuses 1/2 defer only after that report and exact
post-scan coverage validate; operational status 3, timeout/signal statuses,
unexpected statuses, and malformed evidence block. The scanner does not receive
user, device, or media capabilities, so broken authorization, tenant isolation,
authenticated state transitions, and private-media delivery still require
targeted automated and manual tests. Runner-local certificates and networking
also do not evidence production DNS, TLS, firewall, WAF, rate-limit, or
monitoring behavior.

Production CORS configuration is parsed as a bounded exact-origin list before
startup. Wildcard and opaque `null` origins, credentialed or path-bearing URLs,
insecure network origins, local/private hosts, and arbitrary custom schemes are
rejected. The packaged Player retains only the exact `https://localhost` and
`capacitor://localhost` exceptions. This constrains browser response access; it
does not replace bearer authentication, capability checks, or tenant scoping.

User access tokens expire after one hour and carry a random per-login
session identity whose SHA-256 hash is stored. Every authenticated user request
checks that exact session's expiry and revocation together with live user,
membership, organization, and role state. Sessions also snapshot independent
user-authentication and membership-authorization epochs; password rotation,
disablement, role mutation, and membership removal advance the applicable epoch,
revoke affected sessions, and append system audit records atomically. Thus a
later restoration of the same password hash or role cannot revive an older
session. The internal lifecycle helpers also refuse to disable, demote, or
remove the last active owner of any affected tenant; PostgreSQL serializes
competing owner changes by tenant, and a multi-tenant disable fails atomically
if any tenant lacks a replacement. This continuity guard is not an ownership
transfer workflow or approval policy. Current-session logout commits the
revocation and audit event atomically without revoking other sessions. The
Console clears local credentials even when that call fails, but explicitly
warns that revocation is unconfirmed until the one-hour expiry. No public
identity-administration routes currently expose the internal lifecycle methods.
External IdP, SSO, MFA, and step-up authentication remain separate
pre-production requirements.

The database and shared policy library contain an additive scoped-
authorization foundation: tenant-constrained flat screen groups, exact grant
scope shapes, a closed non-emergency grant vocabulary, role ceilings, and
deterministic all-target evaluation. A database constraint deliberately keeps
all organizations in `LEGACY` mode. Exact-membership, system-attributed
compatibility grants mirror the current non-emergency role ceiling at
organization scope. Successful non-replayed candidate creation performs a
bounded, failure-isolated comparison inside its transaction and records only a
sanitized audit summary; legacy authorization still decides the mutation. No
resource list or other route is filtered or enforced by grants. These broad compatibility rows
are migration input, not least-privilege evidence. This groundwork is not an
effective scoped control or completion of the authorization gate.

Published releases and release assignments reference guarded, tenant-scoped
membership-attribution tombstones instead of live memberships. Removing a
creator can therefore revoke sessions and enrollment authority without
weakening immutable publication history or its composite tenant boundary. The
tombstone is created in the membership transaction, survives membership and
user deletion, rejects ordinary mutation, and cascades with organization
deletion. The table-owning database role remains outside this local integrity
boundary.

Pending initial and replacement grants snapshot the issuer's membership plus
authentication and authorization epochs. Password rotation, disablement,
any role change, or membership removal revokes those grants and unbound
candidates in the same identity transaction. PostgreSQL takes the tenant lock
before issuer/grant/attempt locks for enrollment proof and management cutover,
so a concurrent lifecycle change either precedes proof or revokes its staged
result; restoring a role does not restore the old authority.

Known and unknown invalid credentials take the same password-verification and
response path and create tenant-neutral failure telemetry keyed only by
deployment-secret, domain-separated HMACs of normalized account and request
source. Rate-limit rejections use the same opaque keys. No raw email, password,
or IP address is stored. Telemetry writes fail safe with an
`AUTH_TELEMETRY_UNAVAILABLE` response rather than permitting an unrecorded
failure; the response is identical for known and unknown accounts. The local
store retains at most the newest 10,000 rows and removes rows older than 30 days
during later inserts. This insertion-triggered retention is not a SIEM, alerting
pipeline, or immediate deletion scheduler, and sustained attacks can churn the
bounded window.

The PostgreSQL login lookup resolves identity eligibility and its stable
first-organization compatibility membership in one fixed statement. Active,
unknown, disabled, and membershipless outcomes each lead to exactly one bcrypt
comparison, with a supported fixed cost-12 dummy credential used whenever no
eligible identity is returned. This narrows account-existence and membership
timing differences; database execution, scheduler effects, rate limiting, and
successful session creation remain data-dependent, so this is not a constant-
time authentication claim.

Emergency activation and clear capabilities are not present in any legacy role
bundle, so no current authenticated role can invoke the dormant routes even if
the non-production feature flag is misconfigured. Transactional store fixtures
remain for future workflow development. Production also remains hard-disabled
at configuration validation pending strong re-authentication, distinct-person
approval, delivery acknowledgement, recovery, and tabletop evidence.

Proof-v1 manifest responses additionally sign the one-use challenge ID
consumed for that request, and the Player requires an exact match before
acceptance. Online activation rejects signed generation times older than the
persisted active envelope and rejects a different semantic version at the same
generation timestamp, while leaving explicit local rollback available. A
privileged local attacker who can replace both application state and cached
envelopes may still roll state back; rollback-resistant native storage remains
a release gate.

## Container posture

Only ports 80/443 are published. Data services use an internal network. Application/static containers run read-only with dropped Linux capabilities and `no-new-privileges`; persistent data uses named volumes. Secrets are injected at runtime and must move from an environment file to a secret manager for production. Pin images by digest and generate an SBOM for release candidates.

## Security validation gate

The database now supports tenant-bound Location records and optional screen
classification, with audited owner/admin management. This is data-model
foundation only: no per-user location grants or resource filtering exist, and
the organization-wide role limitation remains an open production blocker.

Before production, complete authentication/authorization tests, Android
hardware/application attestation design, automatic overlapping credential
rotation, physical-device validation of targeted re-enrollment, verified local
erasure and offline-recall procedures, database-enforced composite tenant
constraints, upload fuzzing, dependency and container scanning, restore testing,
TLS validation, native-cache full-disk/power-loss and player downgrade/rollback testing,
external penetration testing, and an emergency-workflow tabletop exercise.
Automated re-enrollment route tests establish protocol behavior only; they do
not close the attestation, physical custody/fingerprint verification, Keystore or
media erasure, offline recall, or rotation gates. Track accepted risk with an
owner and review date.

## Private media delivery

The object bucket is private, and the public proxy never routes directly to
MinIO. Proof-authenticated protocol-v2 POST manifests bind the canonical
header-delivery negotiation to device proof and carry query-free same-origin
media URLs plus separate short-lived GET capabilities
bound to the active credential key ID, device, tenant, immutable asset,
immutable assignment ID/digest, server-derived storage key, digest, size, and
the earliest manifest, schedule, or frozen-asset deadline. On each delivery,
the API rechecks that exact credential key and the tenant/screen-specific latest
assignment remain active before reading only the signed key from its fixed S3
endpoint; withdrawal, replacement, asset expiry, or a schedule boundary denies
the old capability without disclosing which condition failed. It never fetches
a stored arbitrary URL. Storage fetches request identity encoding, reject any
encoded response, require a canonical declared length, and independently stop
the delivered stream before it can exceed the signed byte count. The final byte
is released only at clean upstream EOF, so a late extra chunk, truncation, or
upstream error aborts delivery; downstream cancellation destroys the upstream
stream.
Media delivery does not require another per-media proof signature: a captured
capability is replayable only while its bound credential and assignment remain
active and until its earliest signed deadline. Withdrawal blocks new reads once
the database change commits; a request that passed the authorization recheck
before that commit may finish streaming, and already-downloaded offline bytes
remain governed by the signed playback and asset-expiry boundaries.
Capabilities are accepted only through one exact `MediaCapability`
Authorization header; any query, duplicate, wrong scheme, malformed token, or
v1 token is an opaque 404 before storage access. API logs redact Authorization
and request URLs, Caddy access logging is disabled, and any external ingress/APM
must also redact Authorization. The signed manifest still persists the opaque
capability in IndexedDB until its manifest record is replaced or cleared.

The schema upgrade deliberately aborts when legacy media or frozen release rows
exist: their public URL metadata cannot prove that bytes are present at the new
private key. Before retrying, an operator must use a separately reviewed
migration runbook to copy every object into its derived tenant/asset/digest key,
verify the complete SHA-256 and byte size against metadata, preserve immutable
release snapshots, and commit metadata only after all verification succeeds.
No automatic URL-to-key backfill is permitted.

CodeQL's `js/insufficient-password-hash` query mistakes the S3 signing key for
a user password because AWS Signature Version 4 intentionally derives request
keys with HMAC-SHA256. The SARIF false-positive acceptance matches only that query's exact message and
source region, and only while every constructor call site and the SigV4
implementation retain their reviewed Git object hashes. A changed call site,
implementation, finding location, or message becomes blocking. This acceptance
does not exclude dependencies, generated code, paths, or any other finding.

Browser upload, sniffing, scanning, decoding, and transcoding remain disabled
and are not closed by this delivery control. A private quarantine and
safe-derivative pipeline remains a pre-production gate.

The legacy caller-supplied metadata registration route and configuration switch
have been removed. No upload, multipart, media-ingestion, or caller-directed
remote-fetch route is registered. The proposed private
ingestion state machine, separate quarantine authority, fail-closed scanner,
reader-visible promotion transaction, deterministic orphan reconciliation, and
safe-derivative gates are documented in `MEDIA_INGESTION_DESIGN.md`; this design
does not complete the upload pre-production gate.
