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

- screen ID, stable semantic version, generation time, and expiry;
- schedule priority and ordered items;
- a signed `withdrawn` flag; a withdrawal is an empty, normal-priority release that intentionally clears playback;
- an optional signed `playbackEndsAt` boundary for the selected schedule, distinct from the routinely refreshed envelope lease;
- immutable asset URL, media type, size, SHA-256, and duration;
- minimum compatible player version where needed;
- a signature over a canonical representation.

The player downloads into a staging cache, validates size and SHA-256, then atomically marks the new manifest active. The WebView path bounds cache-miss content to 128 MiB per asset and 512 MiB per release, limits concurrency to two downloads, and prunes outside active/rollback generations; native stream-to-disk verification remains a release gate for larger content. It retains at least one prior complete normal manifest, and emergency overlays never replace that rollback baseline. The API signs manifests with Ed25519. During pairing the player pins that deployment's public verification key and verifies the exact signed envelope plus its expected screen ID before staging. Signing-key rotation with overlap/key IDs remains a pre-production gate. A failed signature, download, clock check, or activation preserves the last-known-good manifest.

Playback telemetry identifies content only after the active image loads, video
enters playing, web frame loads, or a validated template commits. The item
duration begins at that readiness point. A separate bounded readiness watchdog
recovers silent resolver, decoder, or navigation stalls, and generation-scoped
events cannot advance or fail a newer item. An iframe load event proves
navigation completion, not pixels rendered; physical display and proof-of-play
evidence remain pre-production gates.

Routine polls may refresh `generatedAt`, `validUntil`, and the signature without changing `version`; the version changes only when the semantic release changes. `validUntil` is the signed-envelope lease, while `playbackEndsAt` is the hard schedule authorization boundary enforced locally during an outage. When no schedule applies, or an applicable schedule has no playable non-expired assets, the API emits a signed withdrawal so previously active content does not continue past its authorization window.

Daily times use local wall-clock semantics in the configured IANA time zone. A boundary that does not exist during a spring-forward gap advances to the first valid instant after the gap. During a fall-back repeat, starts use the later occurrence and ends use the earlier occurrence. This prevents early activation and prevents ended content from reactivating when the clock repeats.

Emergency overrides are distinct, expire explicitly, and never erase the baseline schedule. Emergency publishing remains disabled by default until separate approval, player acknowledgement, and partial-delivery handling are implemented and physically tested.

## Commands (planned; disabled in this prototype)

Before commands are enabled, they must have unique IDs, issue/expiry timestamps, a constrained type, and arguments validated by allowlist. Players must acknowledge `received`, then `completed` or `failed`; expired or replayed IDs must be ignored. Arbitrary shell command execution is out of scope.

## Transport and retries

HTTPS polling is the baseline transport. A push channel may reduce latency but polling remains the recovery path. Mutating acknowledgements are idempotent. Clients use capped exponential backoff with jitter and honor `Retry-After`. Certificate validation must never be disabled outside a dedicated local development build.

## Credential rotation and decommissioning

The schema has a revocation timestamp and authentication honors it, but no operator-facing revoke/rotate/decommission API exists yet. Those workflows and verified local erasure remain release gates. The completed design must redact credentials in telemetry, revoke them immediately on decommissioning, and erase downloaded media and local state on factory reset.
