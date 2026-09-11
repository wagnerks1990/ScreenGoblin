# Player protocol

Initial pairing is relative to the configured server URL. The pairing response returns the device API base URL. Authenticated calls send `X-Screen-Id` and `X-Device-Token`; neither value belongs in a URL or log.

| Method | Endpoint                       | Purpose                                           |
| ------ | ------------------------------ | ------------------------------------------------- |
| POST   | `/api/v1/device/pair`          | Consume an admin-created short-lived pairing code |
| GET    | `{deviceApiBaseUrl}/manifest`  | Fetch this screen's fully resolved manifest       |
| POST   | `{deviceApiBaseUrl}/heartbeat` | Report actual player and playback state           |

Remote device commands are intentionally not enabled in the current prototype. They require persistent command records, expiry, authorization, replay resistance, idempotent acknowledgement, and hardware capability checks before activation.

## Android identity bridge

The Android application registers a `DeviceIdentity` Capacitor plugin. It keeps
a P-256 private key non-exportable in Android Keystore, prefers StrongBox where
available, and returns the public SPKI, SHA-256 public-key fingerprint, `ES256`
algorithm label, and detected security level. Security-level metadata is local
diagnostic information, not remote attestation.

For a new Android installation, the fingerprint is also used as the installation
ID. An existing `sg-installation-id` value always wins for compatibility with an
already-paired prototype. Non-Android players retain a persisted random UUID.

The plugin can sign a 16–512-byte, unpadded-base64url challenge with
`SHA256withECDSA` after prefixing the decoded bytes with the domain
`ScreenGoblin device proof v1` and a zero byte. It returns the signature in DER
form encoded as unpadded base64url. The API does not yet enroll this key or
verify these proofs. Until that server protocol, nonce replay cache, lifecycle,
and local-erasure flow exist, the current IndexedDB bearer token remains the
actual authentication mechanism.

The manifest includes `version`, `generatedAt`, `validUntil`, `screenId`, `priority`, and ordered playlist `items`. Each playlist item contains an `asset` plus `durationSeconds`; the player normalizes that wire shape before staging. Image, video, and template checksums are mandatory. URLs should be immutable or short-lived signed URLs whose content bytes stay stable for the URL lifetime.

The envelope declares `signatureAlgorithm: Ed25519` and includes `signature`.
Pairing returns `manifestVerificationKey`; the player pins that public key and
rejects altered manifests, wrong-screen manifests, unsupported algorithms, and
expired releases before staging. Changing the signing key currently requires
controlled player re-enrollment; overlap/key-ID rotation is still required.

Emergency manifests use priority `emergency`; the player visibly labels them. Normal schedules are restored by publishing a new normal manifest. Device authentication tokens should be independently revocable and rotated by the server.
