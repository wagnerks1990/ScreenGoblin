# Device enrollment and playback protocol

## Trust model

The Android wrapper creates a non-exportable P-256 signing key in Android
Keystore, preferring StrongBox when the device advertises it and falling back to
the platform Keystore provider. It exposes the public SPKI, its SHA-256 key
fingerprint, and a constrained signing operation; private-key bytes never cross
into the WebView. This is only the client foundation: the current server does
not enroll the public key, issue proof challenges, verify signatures, or attest
the reported hardware security level. The unique bearer credential stored in
the player WebView's IndexedDB therefore remains authoritative and is not
platform-protected native storage. Sharing one fleet API key is prohibited.

Existing locally stored installation IDs are preserved for prototype upgrade
compatibility. New Android installs use the public-key fingerprint; browsers
and PWAs use a persisted random UUID. Pairing codes are short-lived, single-use,
and stored using a deployment-specific HMAC pepper. Before a real fleet pilot,
the server must bind the key during enrollment and require fresh, replay-safe
proof of possession for sensitive device operations.

## Enrollment

1. An authorized operator creates a six-digit pairing code in the Console/API.
2. The operator enters that code on the unpaired player.
3. The player exchanges the code plus installation metadata over TLS.
4. The server atomically consumes the code and issues a device credential.
5. The player stores the transitional credential in IndexedDB and begins heartbeats.

Codes expire after ten minutes. Durable distributed limits, operator
confirmation, safe re-enrollment, rotation, and decommissioning remain release
gates.

### Android challenge-signing contract (client foundation)

`DeviceIdentity.signChallenge` accepts an unpadded base64url value that decodes
to 16–512 bytes. It signs the UTF-8 domain separator
`ScreenGoblin device proof v1` followed by a zero byte and the decoded challenge
using `SHA256withECDSA`. The returned signature is ASN.1 DER encoded and then
unpadded base64url encoded (`ES256-DER`). A future server verifier must reproduce
that exact byte sequence, enforce one-time challenge expiry and device binding,
and reject replays. This operation is currently unused by the bearer-token API.

## Heartbeat

The normal heartbeat contains installation ID, player and OS versions, uptime, free storage, network type, active manifest version, and current asset ID. The server returns the next interval. Command delivery and jittered scheduling are required before fleet rollout but are not enabled in this prototype.

The UI derives online/warning/offline state from server receipt time, never from a device-supplied clock alone.

## Manifest

A manifest contains:

- screen ID, version, generation time, and expiry;
- schedule priority and ordered items;
- immutable asset URL, media type, size, SHA-256, and duration;
- minimum compatible player version where needed;
- a signature over a canonical representation.

The player downloads into a staging cache, validates size and SHA-256, then atomically marks the new manifest active. It retains at least one prior complete normal manifest, and emergency overlays never replace that rollback baseline. The API signs manifests with Ed25519. During pairing the player pins that deployment's public verification key and verifies the exact signed envelope plus its expected screen ID before staging. Signing-key rotation with overlap/key IDs remains a pre-production gate. A failed signature, download, clock check, or activation preserves the last-known-good manifest.

Emergency overrides are distinct, expire explicitly, and never erase the baseline schedule. Emergency publishing remains disabled by default until separate approval, player acknowledgement, and partial-delivery handling are implemented and physically tested.

## Commands (planned; disabled in this prototype)

Before commands are enabled, they must have unique IDs, issue/expiry timestamps, a constrained type, and arguments validated by allowlist. Players must acknowledge `received`, then `completed` or `failed`; expired or replayed IDs must be ignored. Arbitrary shell command execution is out of scope.

## Transport and retries

HTTPS polling is the baseline transport. A push channel may reduce latency but polling remains the recovery path. Mutating acknowledgements are idempotent. Clients use capped exponential backoff with jitter and honor `Retry-After`. Certificate validation must never be disabled outside a dedicated local development build.

## Credential rotation and decommissioning

The schema has a revocation timestamp and authentication honors it, but no operator-facing revoke/rotate/decommission API exists yet. Those workflows and verified local erasure remain release gates. The completed design must redact credentials in telemetry, revoke them immediately on decommissioning, and erase downloaded media and local state on factory reset.
