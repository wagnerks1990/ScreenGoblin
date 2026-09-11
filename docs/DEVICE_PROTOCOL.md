# Device enrollment and playback protocol

## Trust model

The prototype creates a random installation ID and stores its unique bearer credential in the player WebView's IndexedDB. This is **not** platform-protected native key storage. Pairing codes are short-lived, single-use, and stored using a deployment-specific HMAC pepper, but distributed/per-code attempt budgets are not implemented yet. Before a real fleet pilot, device identity must use non-exportable asymmetric key material in Android Keystore and server-verified proof of possession. Sharing one fleet API key is prohibited.

## Enrollment

1. An authorized operator creates a six-digit pairing code in the Console/API.
2. The operator enters that code on the unpaired player.
3. The player exchanges the code plus installation metadata over TLS.
4. The server atomically consumes the code and issues a device credential.
5. The player stores the credential in platform-protected storage and begins heartbeats.

Codes expire after ten minutes. The prototype applies an in-process source rate limit; durable distributed limits, operator confirmation, safe re-enrollment, rotation, and decommissioning remain release gates.

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
