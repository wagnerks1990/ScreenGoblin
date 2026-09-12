# API overview

## Conventions

- Base path: `/api/v1` behind the reverse proxy.
- Payloads: UTF-8 JSON unless an upload endpoint documents otherwise.
- Time: RFC 3339 UTC timestamps at the API boundary; schedules retain an IANA time-zone name.
- IDs: opaque strings. Clients must not infer order or tenancy from them.
- Authentication: users send `Authorization: Bearer <token>`. Production devices use the `proof-v1` challenge protocol documented below. `X-Device-Token` is accepted only when the API is explicitly running in `development-bearer` mode; that mode is limited to non-production localhost Player development. Credentials, challenges, signatures, and enrollment codes must not appear in URLs or logs.
- Errors: stable machine-readable code, safe human-readable message, and request ID. Validation errors may include field paths.
- Mutations that may be retried should accept an idempotency key. This is required before payment-like or emergency workflows are introduced.

Shared request and response shapes are defined in `packages/contracts`. The OpenAPI document generated or maintained by the API is the detailed endpoint authority once available.

User bearer envelopes and their server-side session rows expire after one hour.
Each row snapshots the user's authentication epoch and the selected membership's
authorization epoch; every authenticated request compares both snapshots with
current state. `POST /auth/logout` revokes only the presented session. Password
rotation, user disablement, role change, and membership removal exist only as
trusted internal, system-audited store operations in this prototype; there are
no public identity-administration endpoints.

## Main resource groups

| Group          | Purpose                                                          | Principal       |
| -------------- | ---------------------------------------------------------------- | --------------- |
| Authentication | Sign-in and current session                                      | User            |
| Screens        | Fleet inventory, state, tags, and assignment                     | User            |
| Media          | Bounded pre-provisioned metadata; Console inventory is read-only | User            |
| Playlists      | Ordered media and durations                                      | User            |
| Schedules      | Time rules, priority, and targets                                | User            |
| Pairing        | Short-lived enrollment code exchange                             | User/device     |
| Device         | Pairing, heartbeat, and manifest delivery; commands are disabled | Device          |
| Emergency      | Expiring high-priority overrides                                 | Privileged user |
| Audit          | Security- and publishing-relevant events                         | Admin/auditor   |

`GET /audit-events` returns a tenant-scoped latest-event window of at most 200
rows, ordered by descending `(createdAt, id)` so timestamp ties are stable. It
has no cursor or historical-export contract and cannot reconstruct an
arbitrarily long history. Local rows are shape- and size-bounded. Ordinary
updates and direct row deletion are rejected by PostgreSQL, with narrow
exceptions for deleting a referenced user or organization. The table owner can
disable these controls or truncate the table, so this is not a tamper-evidence,
WORM, retention, or legal-hold boundary.

## Authorization rules

Every user resource query must include the authenticated organization boundary. A caller-provided organization ID is never sufficient authorization. Devices are restricted to their own screen and current organization. Object keys must be server-generated and tenant-prefixed. Emergency activation requires a separately audited permission; district-wide two-person approval is a production requirement.

Screen creation/update and media/playlist creation/deletion revalidate the
actor's active membership and allowed role inside the database transaction that
performs the mutation and appends its audit event. Screens require `OWNER` or
`ADMIN`; media and playlists also allow `PUBLISHER`. A concurrent disablement,
demotion, cross-organization identifier, resource-in-use conflict, or audit
write failure leaves both resource state and audit history unchanged.

Production initial-enrollment authority can be created only for a precreated,
tenant-owned `Screen` by an `OWNER` or `ADMIN`. The transaction locks the tenant,
revalidates the issuer's membership and authentication/authorization epochs,
and binds those snapshots to a ten-minute grant. A concurrent password reset,
disablement, demotion, or membership removal revokes that pending grant. The old
unbound `POST /pairing-codes` route returns `410` in proof-v1 mode.

Device-credential revocation and targeted re-enrollment require their exact
screen credential capabilities. The compatibility role adapter grants them only
to `OWNER` and `ADMIN`. The route and transactional store both revalidate the
actor's current organization membership and capability. Revocation marks the
credential and screen, invalidates its outstanding challenges and pending
re-enrollment grants, advances the credential generation, and appends the audit
event in the same transaction. Repeating an already-completed revocation is
idempotent and does not append a second audit event.

Ordinary release publication and withdrawal use a closed, deny-by-default capability adapter. The API checks the capability at the route boundary, and the transactional store re-evaluates the actor's current organization membership and capability before writing release state or audit history. For compatibility, `OWNER`, `ADMIN`, and `PUBLISHER` currently receive `release.publish` and `release.withdraw`; `VIEWER` receives neither. This adapter does not yet provide resource scopes, custom grants, or reviewer/publisher separation.

Media metadata creation and manifest publication are fail-closed: each URL
origin must exactly match an explicitly configured allowlist entry. Production
entries are origin-only HTTPS URLs using non-local DNS hostnames; URL credentials
are rejected. The metadata-only pilot boundary accepts exact MIME/kind pairs for
JPEG, PNG, MP4, and JSON templates, requires a positive size no greater than
128 MiB, canonicalizes SHA-256 to lowercase, and accepts only future expiries.
Web assets are disabled. The API does not fetch a submitted legacy URL, sniff,
scan, decode, transcode, or upload the object. Private delivery fetches only the
server-derived key from the configured S3 endpoint, requests identity encoding,
rejects encoded or malformed-length responses, and enforces the signed size on
the actual stream, withholding its final byte until clean upstream EOF. Players
reject redirects while downloading binary assets; a hostname can still resolve
to a private address, so controlled DNS and
player-network egress remain required.

## Caching and consistency

Mutable management responses use `Cache-Control: no-store`. Published media may be immutable and long-lived when addressed by checksum. Manifests include a stable semantic version, envelope validity window, signed `withdrawn` state, optional signed `playbackEndsAt` schedule boundary, optional signed asset expiries, checksums, `signatureAlgorithm: Ed25519`, and a signature. Pairing pins `manifestVerificationKey`; a player verifies the signed envelope and screen binding, then activates only after every required asset has been verified. Frozen ordinary releases are delivered as a whole: if any item fails the current URL-origin, credential, media, expiry, checksum, size, or aggregate policy, the API emits a signed normal-priority withdrawal with no items instead of signing a partial playlist. The same withdrawal clears playback when no schedule applies. Players may retain normal last-known-good playback past the routinely refreshed `validUntil` lease during an outage, but must stop it at `playbackEndsAt` or the earliest asset expiry.

## Ordinary release publication

`POST /schedules` atomically freezes playlist metadata, ordered item and asset
playback facts, target screen IDs, and the scheduling window into an immutable
release assignment. It also writes the required audit event in the same
transaction. The existing schedule response remains compatible and adds
`releaseId` and `assignmentId`. Repeating an identical active assignment returns
the existing records. Publication fails without partial records when a source
or target is missing, the playlist is empty, an asset is expired, unsupported,
malformed, larger than 128 MiB, outside the exact-origin policy, or the release
would exceed 512 MiB.

Publication requires an `Idempotency-Key` containing a canonical lowercase
UUIDv4. The server stores only a domain- and organization-bound SHA-256
fingerprint, never the raw header. A committed retry by the same currently
authorized actor with the same canonical request returns the original `201`
schedule body, including after that schedule has been withdrawn; replay never
creates an assignment or audit event. Reusing the key for another payload or
actor returns `409 IDEMPOTENCY_KEY_REUSED`. A fresh key represents a deliberate
new publication intent and may reactivate unchanged content after withdrawal.
Validation and authorization failures do not consume a key.

Response bodies remain replayable for 30 days. Presenting that key after expiry
compacts its body to a permanent tenant-bound command tombstone; an
expired key returns `409 IDEMPOTENCY_KEY_EXPIRED` and is never reusable. A
dormant key can retain an expired response body until it is presented again,
but tenant deletion removes both ledger and content. A replayed `201` describes
the historical command result, not current assignment state; clients must read
current schedule or manifest state after recovery.

`DELETE /schedules/:id` appends an immutable withdrawal assignment and its audit event instead of deleting release history. It is idempotent after the first withdrawal. `GET /schedules` excludes a schedule when its deterministic latest assignment is withdrawn, while retaining its immutable database history. Ordinary device manifests are selected exclusively from frozen release and assignment snapshots; later source edits or deletion attempts cannot rewrite an already published release.

## Device proof protocol

Production requires `DEVICE_AUTH_MODE=proof-v1`; configuration validation rejects `development-bearer` when `NODE_ENV=production`. Proof-v1 uses an Android Keystore P-256 identity and never returns or accepts a device bearer token.

### Enrollment

1. An `OWNER` or `ADMIN` precreates the tenant `Screen`, then calls
   `POST /screens/:id/device-enrollment` with a reason and canonical UUIDv4
   `Idempotency-Key`. The response contains a ten-minute six-digit code and
   target-bound grant. Only an HMAC verifier and a deterministic code counter
   are stored; the plaintext code and raw idempotency key are not.
2. `POST /device/pair/challenge` receives the code, device metadata, and `{ algorithm: "ES256", publicKeySpki, keyId, securityLevel }`.
3. The API validates the P-256 identity and returns a 30-second challenge.
4. The device signs the domain-separated challenge and repeats the exact
   enrollment transcript at `POST /device/pair`.
5. Valid proof stages a candidate and returns `202 pending-approval`; it does
   not create a credential or attach the device.
6. A current `OWNER` or `ADMIN` reads the candidate metadata and activates the
   exact 43-character fingerprint through the target screen route with a second
   idempotency key. The serializable transaction rechecks the original issuer's
   exact membership and epochs, permits one winner, revokes competitors, creates
   the credential, and keeps the screen offline until its first authenticated
   heartbeat.

At most four live challenges/candidates are admitted per grant. A stolen code
can stage a candidate but cannot activate it. Fingerprint comparison is a manual
operator control, not server-verified physical identity, application/hardware
attestation, two-person approval, MFA/step-up, or location-scoped authorization.
Creation and activation responses are exactly replayable for 30 days; expired
grants/attempts and response records are pruned opportunistically in bounded
100-row batches per maintenance phase on later authorized enrollment writes, so a
dormant or unusually backlogged database still needs an approved scheduled
retention job. A replay describes the original command result, not current
grant or credential state; clients must read the grant/screen after recovery.

### Manifest and heartbeat authorization

Before each protected operation, the player sends `POST /device/challenges` with `X-Screen-Id`, `X-Device-Key-Id`, and `{ operation, bodySha256 }`. `operation` is exactly `manifest` or `heartbeat`. Manifest uses the lowercase hexadecimal SHA-256 of an empty body. Heartbeat uses the SHA-256 of the shared recursively key-sorted canonical JSON body. The API returns a fresh 32-byte challenge with a 45-second expiry and retains at most four live challenges per credential and operation.

The protected request repeats `X-Screen-Id` and `X-Device-Key-Id` and adds:

- `X-Device-Challenge-Id`
- `X-Device-Challenge`
- `X-Device-Signature-Format: ES256-DER`
- `X-Device-Signature`

The signature covers the same domain-separated raw challenge bytes used during enrollment. The server binds the challenge to the active credential, operation, and request-body digest; rechecks that the credential is live, unexpired, and not revoked; and consumes it once after a valid signature. Invalid signatures do not consume a challenge. Heartbeat challenge consumption and the screen update share one transaction. A manifest challenge is consumed before manifest content is resolved. Each safe manifest retry obtains a new proof; a heartbeat is not automatically replayed.

Syntactically valid challenge requests for unknown, detached, expired, or revoked credentials receive the ordinary response shape but produce unusable challenges. This reduces direct identifier enumeration; it is not a substitute for rate limits, network controls, or monitoring.

### Revocation

`POST /screens/:id/device-credential/revoke` returns `204` for a successful or already-completed revocation, `404` for an unknown screen/credential in the caller's organization, and `403` when the transaction-time capability check fails. Revocation prevents subsequent online challenge use and cancels stale replacement authority. It cannot erase media from an offline player or recall already cached playback; verified local erasure, automatic overlapping rotation, and offline-recall behavior remain pre-production gates.

The upgrade migration repairs older persisted contradictions: screens with an
explicit credential-revocation marker are made offline and lose the detached
identity's operational snapshot. Legacy replacement activations are repaired
only when their stored last-seen time exactly equals the bound candidate's
activation time, the exact tuple emitted by the former synthetic path. Unequal
authenticated-heartbeat timestamps remain authoritative regardless of clock
ordering, and rerunning the guarded backfill does not churn healed rows.

### Targeted initial enrollment

Proof-v1 initial enrollment uses a precreated screen and these no-store
management endpoints:

- `POST /screens/:id/device-enrollment` with a required reason and canonical
  UUIDv4 `Idempotency-Key` creates or exactly replays the ten-minute grant.
- `GET /screens/:id/device-enrollment/:grantId` lists only proved candidate
  metadata and public-key fingerprints.
- `POST /screens/:id/device-enrollment/:grantId/candidates/:candidateId/activate`
  requires the exact fingerprint plus its own UUIDv4 idempotency key.
- `DELETE /screens/:id/device-enrollment/:grantId` revokes the pending grant.

The Player never chooses a screen identifier. The server derives the target
from the grant, rechecks its original issuer and a current activating
OWNER/ADMIN, and creates exactly one credential. A competing candidate or grant
is cancelled. Activation does not synthesize telemetry: the precreated screen
remains offline until the selected credential proves its first heartbeat.

### Targeted re-enrollment

Targeted re-enrollment is an operator-mediated, zero-overlap replacement for one
existing screen. Management responses use `Cache-Control: no-store`. The
management endpoints are:

- `POST /screens/:id/device-reenrollment` with required `{ "reason": "..." }` →
  `{ grantId, screenId, code, expiresAt, generation }`. The authorized request
  immediately revokes/detaches the old credential, consumes its challenges,
  invalidates an older pending grant, advances the screen generation, and writes
  the reason-bearing request audit in one transaction. It clears the detached
  identity's last-seen, playback, uptime, storage, and network snapshot. The
  screen stays offline through activation and becomes online only after the
  activated credential sends its first authenticated heartbeat.
- `GET /screens/:id/device-reenrollment/:grantId` → the target-bound grant and
  proved candidate fingerprints. It never returns signatures, challenges,
  private material, or the six-digit code.
- `POST /screens/:id/device-reenrollment/:grantId/candidates/:candidateId/activate`
  activates exactly that proved fingerprint after an `OWNER` or `ADMIN`
  confirms it. Activation does not synthesize a heartbeat or retain the old
  identity's operational telemetry.
- `DELETE /screens/:id/device-reenrollment/:grantId` cancels the grant so no
  candidate can later activate through it.

The Player explicitly rotates to a fresh P-256 identity, then uses the ordinary
pair challenge endpoints. For a valid targeted grant, public finalization does
not create or attach a credential. Instead, `POST /device/pair` returns HTTP
`202` with:

```json
{
  "status": "pending-approval",
  "grantId": "...",
  "candidateId": "...",
  "keyId": "...",
  "fingerprint": "...",
  "expiresAt": "..."
}
```

An exact retry returns the same `202` while pending. After activation, that same
proved request returns the ordinary `201` proof credential response. The public
device never selects or submits a target screen ID; the server derives it from
the authorized grant.

Activation rechecks the actor, tenant, target screen, unexpired grant, candidate
proof, and credential-generation compare-and-swap. It then creates and attaches
the never-before-enrolled key, updates only device-derived metadata, clears the
screen revocation marker, consumes the grant, cancels competing candidates, and
appends the activation audit atomically. The existing `Screen` and all of its
assignments remain unchanged. A reused key, stale generation, cancelled or
superseded grant, deleted target, or authorization change fails closed.

This is manual recovery with deliberate downtime, not automatic credential
rotation: there is no old/new overlap, grace window, autonomous renewal,
attestation continuity, or rollback.

## Health endpoints

- `GET /health/live` — process is running; must not depend on remote services.
- `GET /health/ready` — process can serve traffic and critical dependencies are reachable.

Health responses must not disclose credentials, connection strings, stack traces, or detailed topology.

## Compatibility policy

Additive fields are backwards-compatible and clients must ignore fields they do not understand. Removing or changing a field requires a versioned endpoint or a supported migration period. The oldest supported player release must be included in manifest compatibility tests before a server release.
