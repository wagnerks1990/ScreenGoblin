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

| Threat                          | Impact                                                                | Required control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential/key theft            | Account/device takeover                                               | MFA/SSO before production and short user sessions. Production devices use a unique enrolled P-256 public-key credential, Android Keystore non-exportable private key, short-lived one-use operation proofs, transactional revocation, and header/log redaction. Targeted recovery immediately revokes the old identity and requires a separately authorized exact-fingerprint activation. Hardware attestation, automatic overlapping rotation, and verified erasure remain gates.                                                                                                                                                                                                                                                                                                              |
| Cross-tenant access             | Data or screen compromise                                             | Organization scoping in every query, negative authorization tests, server-generated object keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Publication retry replay        | A lost response retried after withdrawal silently reactivates content | Required canonical UUIDv4 command keys, tenant/domain-bound SHA-256 fingerprints, canonical request digests, live actor authorization revalidation, and one transaction for publication, audit, and replay state. Same-command retries return the historical response without writing assignments; actor/payload reuse conflicts. Full responses expire after 30 days and compact to durable non-reusable tombstones.                                                                                                                                                                                                                                                                                                                                                                           |
| Pairing-code guessing/theft     | Rogue device enrollment                                               | Short expiry, collision-safe allocation, transaction-time active OWNER/ADMIN revalidation for issuance, HMAC protection at rest, source/code rate limits, bounded live challenges, transcript- and key-bound P-256 proof, transactional one-time claim and audit. Initial enrollment remains first-valid-proof authority. For targeted re-enrollment, a stolen code can only stage a candidate: separate OWNER/ADMIN activation of the exact physical-player fingerprint is required before a credential exists. Hardware/app attestation remains absent.                                                                                                                                                                                                                                       |
| Device-proof replay             | Forged heartbeat/content access                                       | Random 30-second pairing and 45-second operation challenges stored only as hashes, fixed operation and canonical body-digest binding, strict domain-separated P-256 signatures, active credential recheck, and atomic one-use consumption. Invalid signatures do not consume a challenge; valid proofs cannot be replayed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Revoked/offline player          | Continued stale playback                                              | OWNER/ADMIN transactional revocation invalidates online proofs, outstanding challenges, and stale re-enrollment grants. Revocation cannot reach a disconnected player, erase cached media, or override signed local playback boundaries; network containment, physical recovery, and verified native erasure remain required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Re-enrollment race/substitution | Unauthorized replacement or restored revoked access                   | A targeted grant binds one tenant screen and captured credential generation. Request atomically revokes/detaches the prior identity. Fresh-key proof creates only a pending candidate; a separate current OWNER/ADMIN must activate its exact fingerprint. Replacement clears the detached identity's operational telemetry and remains offline until the new credential's authenticated heartbeat. Generation compare-and-swap, cancellation, globally unique key IDs, ordered locks, and one-live-credential constraints reject stale grants, competing candidates, revoke races, and prior-key reuse. This does not establish physical-device identity.                                                                                                                                      |
| Manifest or media tampering     | Unapproved display content                                            | TLS, server-side recomputation of complete frozen release/latest-assignment digests before selection, signing, and media authorization, exact manifest signing bytes retained and reverified with the pinned key/screen on boot and rollback, normalized-view equality, native app-private stream-to-disk size/SHA-256 verification, atomic file publication, verified legacy-cache fallback, and fail-closed activation. Digest mismatches do not emit per-read audit rows; external database-integrity and repeated-withdrawal/404 monitoring is required. These unkeyed digests do not make a compromised database tamper-proof. A privileged local attacker may still replay an older valid signed envelope; rollback-resistant native state and physical power-loss evidence remain gates. |
| Withdrawn rollback resurrection | Explicitly withdrawn content returns after a later playback failure   | A signed withdrawal is an active local tombstone that atomically deletes the rollback slot. Recovery repairs legacy tombstone state, and rollback validates both signed slots plus playback/asset deadlines before any state swap. A Player that never receives the withdrawal can still use already-downloaded bytes within their signed hard boundaries; server-side recall and rollback-resistant hardware storage remain separate gates.                                                                                                                                                                                                                                                                                                                                                    |
| Player clock correction         | Expired scheduled or emergency content remains visible                | Signed hard deadlines are rechecked against wall time at least every 30 seconds and on WebView resume. An independent countdown prevents a backward correction from extending the lifetime calculated when the current playback session begins, and emergency content blanks before rollback work. This is not trusted time: incorrect initial clocks and device-specific sleep/firmware behavior still require managed time synchronization and physical-device evidence.                                                                                                                                                                                                                                                                                                                      |
| Player storage exhaustion       | Failed updates or playback availability                               | Native available-storage telemetry, bounded signed release sizes, synchronized reservations, app-private staging, cleanup on failure, and active/rollback-aware orphan pruning. A prefetch capacity or I/O failure preserves last-known-good playback. Representative low-space/full-disk, process-death, reboot, and power-loss tests on production filesystems remain pre-production gates.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Malicious upload                | Player/browser compromise                                             | Browser upload and web media are disabled. The metadata-only pilot boundary restricts exact MIME/kind pairs and sizes, but it does not fetch, sniff, scan, decode, or transcode pre-provisioned objects; a private quarantine/scanning/transcoding pipeline remains a pre-production gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Stored XSS/template injection   | Admin session compromise                                              | Web content is disabled. JSON templates are schema/length/color validated and rendered as text without arbitrary markup or scripts; browser CSP remains defense in depth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| URL content and redirect abuse  | Player-network/internal access                                        | Production requires an explicit exact-origin HTTPS allowlist with public DNS hostnames; credentialed URLs and binary download redirects are rejected, and web media is disabled. The API does not fetch media. The native bridge bypasses WebView CORS and accepts HTTPS, so honest calls still depend on signed manifests and server origin validation; a compromised WebView requires VLAN egress enforcement or a fetch proxy. DNS rebinding and private-address resolution remain deployment/pre-production gates.                                                                                                                                                                                                                                                                          |
| Emergency misuse                | Panic or unsafe instruction                                           | Separate permission, clear scope/expiry, re-authentication and two-person approval in production, immutable audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Replay/forged commands          | Fleet disruption                                                      | Commands disabled in prototype; require signed expiring IDs, replay cache, authorization, and allowlisted handlers before enablement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Denial of service               | Console/API/player outage                                             | Request/body limits, rate limits, bounded retries/timeouts/download concurrency and verification memory, cache retention, cached playback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Dependency/build compromise     | Supply-chain execution                                                | lockfile, protected branches, dependency review, CodeQL, secret scan, image scan, signed artifacts/SBOM before production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Database/object loss            | Lost schedules/media/audit                                            | Encrypted versioned backups, restore drills, retention and off-host copies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Local audit row mutation        | Incomplete or misleading local history                                | Bounded scalar/JSON fields and a PostgreSQL trigger reject ordinary row updates and direct deletes while preserving current user and tenant deletion semantics. The API currently uses the table-owning login, which can disable the trigger or truncate/rewrite the table. There is no hash chain, independently protected anchor, outbox/export monitor, approved retention job, or legal hold, so these controls address application mistakes rather than a compromised database or administrator.                                                                                                                                                                                                                                                                                           |
| Screenshot privacy leak         | Unintended personal data                                              | Role-gate, audit, short retention, encryption, disable per location where required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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

User access tokens expire after one hour and carry a random per-login
session identity whose SHA-256 hash is stored. Every authenticated user request
checks that exact session's expiry and revocation together with live user,
membership, organization, and role state. Sessions also snapshot independent
user-authentication and membership-authorization epochs; password rotation,
disablement, role mutation, and membership removal advance the applicable epoch,
revoke affected sessions, and append system audit records atomically. Thus a
later restoration of the same password hash or role cannot revive an older
session. Current-session logout commits the revocation and audit event atomically
without revoking other sessions. The Console clears local credentials even when
that call fails, but explicitly warns that revocation is unconfirmed until the
one-hour expiry. No public identity-administration routes currently expose the
internal lifecycle methods. External IdP, SSO, MFA, and step-up authentication
remain separate pre-production requirements.

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

The isolated non-production emergency fixture path rechecks current emergency
capabilities, locks organization-scoped targets, and commits each activation or
clear with its audit event in one transaction. Production remains hard-disabled
pending strong re-authentication, distinct-person approval, delivery
acknowledgement, recovery, and tabletop evidence.

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
MinIO. Proof-authenticated manifests carry short-lived bearer GET capabilities
bound to the active credential key ID, device, tenant, immutable asset,
immutable assignment ID/digest, server-derived storage key, digest, size, and
the earliest manifest, schedule, or frozen-asset deadline. On each delivery,
the API rechecks that exact credential key and the tenant/screen-specific latest
assignment remain active before reading only the signed key from its fixed S3
endpoint; withdrawal, replacement, asset expiry, or a schedule boundary denies
the old capability without disclosing which condition failed. It never fetches
a stored arbitrary URL.
Media delivery does not require another per-media proof signature: a captured
capability is replayable only while its bound credential and assignment remain
active and until its earliest signed deadline. Withdrawal blocks new reads once
the database change commits; a request that passed the authorization recheck
before that commit may finish streaming, and already-downloaded offline bytes
remain governed by the signed playback and asset-expiry boundaries. Capability
query values are redacted from structured request logs.

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

The legacy caller-supplied metadata registration route is now disabled by
default and production configuration rejects enabling it. The proposed private
ingestion state machine, separate quarantine authority, fail-closed scanner,
reader-visible promotion transaction, deterministic orphan reconciliation, and
safe-derivative gates are documented in `MEDIA_INGESTION_DESIGN.md`; this design
does not complete the upload pre-production gate.
