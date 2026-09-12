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

## Authorization rules

Every user resource query must include the authenticated organization boundary. A caller-provided organization ID is never sufficient authorization. Devices are restricted to their own screen and current organization. Object keys must be server-generated and tenant-prefixed. Emergency activation requires a separately audited permission; district-wide two-person approval is a production requirement.

Screen creation/update and media/playlist creation/deletion revalidate the
actor's active membership and allowed role inside the database transaction that
performs the mutation and appends its audit event. Screens require `OWNER` or
`ADMIN`; media and playlists also allow `PUBLISHER`. A concurrent disablement,
demotion, cross-organization identifier, resource-in-use conflict, or audit
write failure leaves both resource state and audit history unchanged.

Pairing-code issuance requires `OWNER` or `ADMIN` at both the route and store
boundaries. The store locks and revalidates the actor's current active
membership before expiring colliding codes or creating the new ten-minute
enrollment authority and audit event. A concurrent demotion, disablement, or
membership removal returns `403` without retrying and changes neither pairing
nor audit state.

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
Web assets are disabled. The API stores metadata and does not fetch, sniff, scan,
decode, transcode, or upload the object. Players reject redirects while
downloading binary assets; a hostname can still resolve to a private address,
so controlled DNS and player-network egress remain required.

## Caching and consistency

Mutable management responses use `Cache-Control: no-store`. Published media may be immutable and long-lived when addressed by checksum. Manifests include a stable semantic version, envelope validity window, signed `withdrawn` state, optional signed `playbackEndsAt` schedule boundary, optional signed asset expiries, checksums, `signatureAlgorithm: Ed25519`, and a signature. Pairing pins `manifestVerificationKey`; a player verifies the signed envelope and screen binding, then activates only after every required asset has been verified. A normal-priority withdrawal with no items intentionally clears playback when no schedule or playable asset applies. Players may retain normal last-known-good playback past the routinely refreshed `validUntil` lease during an outage, but must stop it at `playbackEndsAt` or the earliest asset expiry.

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

`DELETE /schedules/:id` appends an immutable withdrawal assignment and its audit event instead of deleting release history. It is idempotent after the first withdrawal. Ordinary device manifests are selected exclusively from frozen release and assignment snapshots; later source edits or deletion attempts cannot rewrite an already published release.

## Device proof protocol

Production requires `DEVICE_AUTH_MODE=proof-v1`; configuration validation rejects `development-bearer` when `NODE_ENV=production`. Proof-v1 uses an Android Keystore P-256 identity and never returns or accepts a device bearer token.

### Enrollment

1. `POST /device/pair/challenge` receives the six-digit code, device metadata, and `{ algorithm: "ES256", publicKeySpki, keyId, securityLevel }`.
2. The API requires canonical unpadded base64url SPKI for a P-256 key, derives `keyId` as unpadded base64url SHA-256 of the SPKI, and requires `device.installationId === keyId`.
3. The API returns an opaque `{ id, challenge, expiresAt }`. The 32-byte pairing challenge expires after 30 seconds, leaving bounded API/database clock-skew tolerance below the database's 45-second hard cap. A syntactically valid request for an invalid code receives the same response shape to reduce code enumeration, but cannot complete enrollment.
4. The device signs `UTF8("ScreenGoblin device proof v1") || 0x00 || challengeBytes` with `SHA256withECDSA`, returning strict ASN.1 DER as unpadded base64url (`ES256-DER`).
5. `POST /device/pair` repeats the exact code, device, and identity fields and adds `pairingProof: { challengeId, challenge, keyId, signatureFormat, signature }`.
6. The API atomically verifies the peppered, domain-separated transcript MAC (including the code), challenge binding, key, signature, expiry, and one-time claim; creates the screen and credential; and appends `device.paired`. The six-digit code is never stored in a recoverable plain digest. An identical successful final request returns the same screen and credential so a lost response can be recovered without duplicating records.

At most four live pairing challenges are retained for the same pairing code and key. Pairing codes still expire after ten minutes and remain first-claim-wins; possession of a code is therefore enrollment authority until operator confirmation or attestation is added.

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

### Targeted re-enrollment

Targeted re-enrollment is an operator-mediated, zero-overlap replacement for one
existing screen. Management responses use `Cache-Control: no-store`. The
management endpoints are:

- `POST /screens/:id/device-reenrollment` with required `{ "reason": "..." }` →
  `{ grantId, screenId, code, expiresAt, generation }`. The authorized request
  immediately revokes/detaches the old credential, consumes its challenges,
  invalidates an older pending grant, advances the screen generation, and writes
  the reason-bearing request audit in one transaction. The screen is offline
  from this request until a candidate is separately activated.
- `GET /screens/:id/device-reenrollment/:grantId` → the target-bound grant and
  proved candidate fingerprints. It never returns signatures, challenges,
  private material, or the six-digit code.
- `POST /screens/:id/device-reenrollment/:grantId/candidates/:candidateId/activate`
  activates exactly that proved fingerprint after an `OWNER` or `ADMIN`
  confirms it.
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
