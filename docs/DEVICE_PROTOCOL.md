# Device enrollment and playback protocol

## Trust model

The Android wrapper creates a non-exportable P-256 signing key in Android
Keystore, preferring StrongBox when the device advertises it and falling back to
the platform Keystore provider. It exposes the public SPKI, its SHA-256 key
fingerprint, and a constrained signing operation; private-key bytes never cross
into the WebView. The server enrolls that public key and requires a fresh,
operation-bound proof for manifests and heartbeats. The enrolled public key is
the production device credential; proof-v1 pairing does not issue a bearer
token. Sharing one fleet API key is prohibited.

Android installation identity is the unpadded base64url SHA-256 fingerprint of
the canonical public SPKI. The server derives the fingerprint itself and
requires `installationId`, the claimed `keyId`, and the derived fingerprint to
match. Browsers and PWAs retain a persisted random UUID and may use bearer
credentials only in an explicitly enabled localhost development build. Pairing
codes are short-lived, single-use, and stored using a deployment-specific HMAC
pepper.

The reported `securityLevel` is descriptive, not trusted attestation. The
server validates P-256 key structure and possession but does not yet validate an
Android hardware-attestation chain, verified boot state, application identity,
or device-management posture. A copied pairing code can therefore be claimed by
the first attacker-controlled key that completes enrollment.

## Enrollment

1. An authorized operator creates a six-digit pairing code in the Console/API.
2. The operator enters that code on the unpaired player.
3. The player sends the code, device metadata, and P-256 identity to
   `POST /api/v1/device/pair/challenge`.
4. The server validates the canonical key and matching fingerprint, binds a
   random 32-byte challenge to the pairing code, key, and canonical transcript,
   and returns its opaque ID and 30-second expiry. Invalid codes receive an
   indistinguishable response shape but cannot complete pairing.
5. The player signs the challenge and repeats the exact enrollment fields plus
   the proof at `POST /api/v1/device/pair`.
6. The server atomically verifies and consumes the code and challenge, creates
   the screen and public-key credential, and appends the pairing audit event.
7. The Player stores only the public credential metadata and pinned manifest
   verification key in IndexedDB, while the private key remains in Keystore.

Codes expire after ten minutes. At most four unconsumed, unexpired pairing
attempts are retained for the same code and key. The final request is
idempotently recoverable only when it repeats the identical successfully
verified transcript and proof, preventing response loss from creating a second
screen or audit record. Source/code distributed rate limits also apply.

Operator confirmation for initial enrollment, attestation, automatic overlapping
credential rotation, and verified decommissioning remain release gates. A
separately authorized, zero-overlap targeted re-enrollment flow is described
below; it is a manual recovery control, not automatic rotation.

### Android challenge-signing contract

`DeviceIdentity.signChallenge` accepts an unpadded base64url value that decodes
to 16–512 bytes. It signs the UTF-8 domain separator
`ScreenGoblin device proof v1` followed by a zero byte and the decoded challenge
using `SHA256withECDSA`. The returned signature is ASN.1 DER encoded and then
unpadded base64url encoded (`ES256-DER`). The server requires strict DER and
reproduces that exact byte sequence. The native bridge refuses to sign if the
requested key ID differs from the current Keystore identity.

## Per-operation proof

For each manifest fetch or heartbeat, the Player first posts the intended
operation and request-body digest to `/api/v1/device/challenges`, identified by
`X-Screen-Id` and `X-Device-Key-Id`. Manifest uses the SHA-256 of an empty body.
Heartbeat uses the lowercase hexadecimal SHA-256 of the shared canonical JSON
body, whose object keys are recursively sorted. There are no query parameters on
the proof-protected manifest endpoint.

The response contains an opaque challenge ID, a fresh unpadded-base64url 32-byte
challenge, and a 45-second expiry. The Player signs the raw challenge bytes and
sends the ID, raw challenge, key ID, `ES256-DER` format, and signature in request
headers. The API binds all of these to the credential, operation, and body
digest. It transactionally rechecks active/not-expired/not-revoked credential
state and allows exactly one valid consumption. Invalid signatures do not burn
the challenge, but a valid proof cannot be replayed. Heartbeat consumption and
the state mutation are atomic. Manifest proof is consumed before resolving the
content response.

At most four live challenges are retained for each credential and operation.
Validly shaped requests for unknown or revoked credentials receive a dummy
challenge response to reduce identifier enumeration; that challenge can never
authorize an operation. Every manifest retry obtains a new challenge and
signature. Heartbeats are not replayed automatically because a proof and body
are one-use.

## Heartbeat

The normal heartbeat contains installation ID, player and OS versions, uptime, free storage, network type, active manifest version, and current asset ID. The server returns the next interval. Command delivery and jittered scheduling are required before fleet rollout but are not enabled in this prototype.

The UI derives online/warning/offline state from server receipt time, never from a device-supplied clock alone.

## Manifest

A manifest contains:

- screen ID, stable semantic version, generation time, and expiry;
- schedule priority and ordered items;
- a signed `withdrawn` flag; a withdrawal is an empty, normal-priority release that intentionally clears playback;
- an optional signed `playbackEndsAt` boundary for the selected schedule, distinct from the routinely refreshed envelope lease;
- immutable asset URL, media type, size, SHA-256, and duration;
- minimum compatible player version where needed;
- a signature over a canonical representation.

The player downloads into a staging cache, validates size and SHA-256, then atomically marks the new manifest active. Persistent cache hits are size-checked and rehashed before reuse and playback. The WebView path bounds content to 128 MiB per asset and 512 MiB per release, limits concurrency to two downloads, and prunes outside active/rollback generations; the API enforces the same byte ceilings when publishing. The metadata-only pilot boundary permits JPEG, PNG, MP4, and JSON templates and disables web assets. Native stream-to-disk verification remains a release gate for larger content. The player retains at least one prior complete normal manifest, and emergency overlays never replace that rollback baseline. The API signs manifests with Ed25519. During pairing the player pins that deployment's public verification key and verifies the exact signed envelope plus its expected screen ID before staging. The exact signing bytes and signature persist with both manifest slots and are reverified on boot and rollback; legacy unsigned or altered records blank and are removed, and a missing active marker cannot revive the prior slot. Signing-key rotation with overlap/key IDs remains a pre-production gate. A failed signature, download, clock check, or activation preserves an already verified last-known-good manifest where safe.

Playback telemetry identifies content only after the active image loads, video
enters playing, or a validated template commits. Web playback is disabled. The item
duration begins at that readiness point. A separate bounded readiness watchdog
recovers silent resolver or decoder stalls, and generation-scoped events cannot
advance or fail a newer item. Physical display and proof-of-play evidence remain
pre-production gates.

Routine polls may refresh `generatedAt`, `validUntil`, and the signature without changing `version`; the version changes only when the semantic release changes. Ordinary items, target IDs, priority, schedule windows, and optional asset expiries come from immutable snapshots created by the atomic publication operation, never from subsequently mutable playlist or schedule rows. `validUntil` is the signed-envelope lease, while `playbackEndsAt` and the earliest signed asset expiry are hard authorization boundaries enforced locally during an outage. An immutable withdrawal event removes the assignment from active selection without deleting its history. When no assignment applies, or an applicable assignment has no playable non-expired assets, the API emits a signed withdrawal so previously active content does not continue past its authorization window.

Daily times use local wall-clock semantics in the configured IANA time zone. A boundary that does not exist during a spring-forward gap advances to the first valid instant after the gap. During a fall-back repeat, starts use the later occurrence and ends use the earlier occurrence. This prevents early activation and prevents ended content from reactivating when the clock repeats.

Emergency overrides are distinct, expire explicitly, and never erase the baseline schedule. Production configuration rejects emergency publishing while separate approval, MFA, player acknowledgement, partial-delivery handling, recovery, and tabletop gates remain incomplete. Non-production fixture coverage does not authorize operational use.

## Commands (planned; disabled in this prototype)

Before commands are enabled, they must have unique IDs, issue/expiry timestamps, a constrained type, and arguments validated by allowlist. Players must acknowledge `received`, then `completed` or `failed`; expired or replayed IDs must be ignored. Arbitrary shell command execution is out of scope.

## Transport and retries

HTTPS polling is the baseline transport. A push channel may reduce latency but polling remains the recovery path. Mutating acknowledgements are idempotent. Clients use capped exponential backoff with jitter and honor `Retry-After`. Certificate validation must never be disabled outside a dedicated local development build.

## Credential revocation and targeted re-enrollment

An `OWNER` or `ADMIN` can invoke
`POST /api/v1/screens/:id/device-credential/revoke`. The API transactionally
revalidates the current membership, marks the credential and screen revoked,
invalidates outstanding challenges, and appends one audit event. Repeated
revocation is idempotent. A revoked credential cannot obtain a usable challenge
or authenticate a subsequent online operation.

Revocation is not offline recall. A disconnected player can continue already
verified cached playback until a signed local playback boundary requires it to
stop, and the server cannot remotely erase that cache. Targeted re-enrollment,
automatic overlapping key/credential rotation, verified native factory-reset
erasure, device-owner attestation, fleet decommission evidence, and physical
proof of removal remain release gates.

Targeted re-enrollment replaces the credential for an existing `Screen`
without recreating the screen or changing its assignments:

1. An `OWNER` or `ADMIN` supplies a required operational reason and requests
   re-enrollment for one screen. The API
   transactionally revalidates authorization, increments the screen's credential
   generation, immediately revokes and detaches its old identity, invalidates
   outstanding device challenges and older grants, creates a ten-minute grant,
   and audits the reason-bearing request. The response includes the grant ID,
   six-digit code, screen ID, expiry, and generation. This containment-first
   request takes the screen offline; activation does not defer the initial
   revocation.
2. The Player requires an explicit local re-enrollment action before deleting
   its former Keystore alias and generating a fresh P-256 key. Merely receiving
   a pairing error or entering an invalid code must never rotate a key.
3. The Player completes the normal transcript-bound pairing challenge with the
   fresh key. `POST /api/v1/device/pair` returns `202` with
   `status: "pending-approval"`, the grant and candidate IDs, key ID,
   fingerprint, and expiry. No credential is created and the candidate cannot
   obtain an operational device challenge at this stage.
4. An `OWNER` or `ADMIN` retrieves the targeted grant and its proved candidates,
   verifies the exact displayed key fingerprint against the physical Player,
   and activates that candidate. Possession of the six-digit code alone can
   therefore never install a replacement credential.
5. Activation revalidates membership and the grant's captured credential
   generation, then atomically creates and attaches the globally new credential,
   updates device-reported screen metadata, clears the screen revocation marker,
   consumes the grant, cancels competing candidates, and appends one audit
   event. The stable screen ID, name, location, tags, schedules, and release
   assignments are preserved.
6. The Player repeats the identical final proof. While approval is pending it
   continues to receive `202`; after activation it receives the ordinary proof
   credential response without another cutover or audit event.

Only one pending targeted grant is permitted per screen. Cancelling a grant,
issuing a newer grant, explicit credential revocation, deleting the target, or
any intervening credential-generation change makes stale activation fail. A
previously enrolled key ID is never reusable, including after revocation.
Concurrent activation, cancellation, revocation, and heartbeat operations are
serialized through the screen generation and transactional locks: at most one
candidate becomes live, and no proof from the detached identity may mutate the
screen after replacement.

This workflow deliberately has a service interruption between the initial
revocation and explicit activation. It does not prove that the replacement is
the same physical device, attest Android hardware/application state, erase
offline media, or implement old/new credential overlap, autonomous renewal,
grace periods, or rollback. Those controls and representative physical-device
evidence remain pre-production gates.

## Deployment modes

`DEVICE_AUTH_MODE=proof-v1` is mandatory in production and production
configuration fails closed for any other value. `development-bearer` exists only
for non-production browser/PWA work against localhost; it preserves the legacy
`X-Device-Token` path and must not be used for a pilot or fleet deployment.
