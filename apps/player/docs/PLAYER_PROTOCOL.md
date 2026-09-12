# Player protocol

Initial pairing is relative to the configured server URL. The pairing response returns the device API base URL. Production Android enrollment and requests use the `proof-v1` protocol; no bearer token is issued in that mode.

| Method | Endpoint                        | Purpose                                       |
| ------ | ------------------------------- | --------------------------------------------- |
| POST   | `/api/v1/device/pair/challenge` | Bind a pairing attempt to a device key        |
| POST   | `/api/v1/device/pair`           | Prove the key and consume the pairing code    |
| POST   | `{deviceApiBaseUrl}/challenges` | Issue a one-use request-bound proof challenge |
| GET    | `{deviceApiBaseUrl}/manifest`   | Fetch this screen's resolved manifest         |
| POST   | `{deviceApiBaseUrl}/heartbeat`  | Report actual player and playback state       |

Remote device commands are intentionally not enabled in the current prototype. They require persistent command records, expiry, authorization, replay resistance, idempotent acknowledgement, and hardware capability checks before activation.

## Android identity bridge

The Android application registers a `DeviceIdentity` Capacitor plugin. It keeps
a P-256 private key non-exportable in Android Keystore, prefers StrongBox where
available, and returns the public SPKI, SHA-256 public-key fingerprint, `ES256`
algorithm label, and detected security level. Security-level metadata is local
diagnostic information, not remote attestation.

The fingerprint is the Android installation ID. A legacy browser
`sg-installation-id` is never allowed to override it. Browser development
players retain a persisted random UUID.

The plugin can sign a 16–512-byte, unpadded-base64url challenge with
`SHA256withECDSA` after prefixing the decoded bytes with the domain
`ScreenGoblin device proof v1` and a zero byte. It returns the signature in DER
form encoded as unpadded base64url. This is the native ASN.1 ECDSA `(r,s)`
encoding, not the fixed-width JOSE signature encoding.

Pairing first sends the code, exact device metadata, and identity to the pairing
challenge endpoint. Both stages use recursively sorted-key canonical JSON. The
API returns an opaque challenge envelope; the player signs those exact decoded
bytes and repeats the exact enrollment fields with `pairingProof` containing
`challengeId`, `challenge`, `keyId`, `signatureFormat`, and `signature`. A
successful identical final claim is idempotent, so a timeout retries the same
serialized body and proof rather than acquiring a different challenge. The
response has `authMode: proof-v1`, `credentialId`, and `keyId`; the player
rejects a response or native signature whose key ID differs from the enrolled
identity.

For targeted re-enrollment, an authorized operator first creates a target-bound
grant, which revokes and detaches the prior credential. Proving a replacement
candidate does not activate or restore it. The Player requires an explicit local
acknowledgement before rotating to a fresh Keystore key;
an invalid code, pairing failure, or unauthorized response must never trigger a
rotation. After fresh-key proof, the final pairing endpoint returns HTTP `202`
with `status: "pending-approval"`, `grantId`, `candidateId`, `keyId`,
`fingerprint`, and `expiresAt`. The Player displays that exact fingerprint for
physical comparison and cannot use the candidate for manifests or heartbeats.

An OWNER or ADMIN separately activates the matching candidate. The Player then
retries the identical serialized final request and proof: it continues receiving
the same `202` while pending and receives the ordinary `201` proof credential
response after activation. The server preserves the existing screen and its
assignments. Cancelled, expired, superseded, revoked, or generation-stale grants
fail closed; a formerly enrolled key cannot be reused.

The Player polls no more often than every 15 seconds so it remains below the
device-pairing rate limit, stops at the earlier of the server expiry or a local
ten-minute bound, and allows the local wait to be paused. Before the first final
POST, the Player stores the exact canonical proof body, API URL, key binding,
and bounded expiry in IndexedDB. This record temporarily contains the pairing
code and is retained only until successful credential persistence, terminal
failure, or expiry. Startup automatically resumes those exact bytes; pause,
network loss, and process termination preserve them. A second identity rotation
is blocked while the record remains unresolved. The Player retains the
prior managed Keystore alias while approval is pending so a generation or
storage failure does not destroy the old identity. Only after a strict `201`
response matches the active key ID does the native bridge delete superseded
ScreenGoblin aliases; it verifies the active alias and never deletes unrelated
application keys. Physical-device evidence that deletion is effective remains
a release gate. The Player persists activated credentials before requesting
this cleanup and retries cleanup during boot, preventing a local deletion
failure from orphaning the server-side activation.

Manifest and heartbeat access first requests a challenge with `X-Screen-Id`
and `X-Device-Key-Id`. Its body names the operation and a lowercase hexadecimal
SHA-256: empty bytes for manifest, or the exact canonical heartbeat JSON bytes.
The protected call echoes the opaque challenge and sends these headers:
`X-Device-Challenge-Id`, `X-Device-Challenge`, `X-Device-Key-Id`,
`X-Device-Signature-Format: ES256-DER`, and `X-Device-Signature`. Manifest GET
retries obtain a fresh challenge and signature for every attempt. Heartbeats
are never automatically replayed.

Browser bearer authentication exists only for local development. It requires
the explicit build-time `VITE_DEVICE_AUTH_DEVELOPMENT_BEARER=true` flag and an
API URL whose hostname is `localhost`, `127.0.0.1`, or `::1`. Android never
uses this fallback, and no client silently downgrades after proof failure.

The manifest includes `version`, `generatedAt`, `validUntil`, `screenId`, `priority`, required signed `withdrawn`, optional signed `playbackEndsAt`, and ordered playlist `items`. Each playlist item contains an `asset` plus `durationSeconds`; the player normalizes that wire shape before staging. A withdrawal is an empty normal release that intentionally clears playback. `validUntil` is the renewable envelope lease; normal last-known-good playback may continue past it during an outage. `playbackEndsAt` is a hard schedule boundary and blanks locally even offline. Image, video, and template checksums are mandatory. URLs should be immutable or short-lived signed URLs whose content bytes stay stable for the URL lifetime.

The envelope declares `signatureAlgorithm: Ed25519` and includes `signature`.
Pairing returns `manifestVerificationKey`; the player pins that public key and
rejects altered manifests, wrong-screen manifests, unsupported algorithms, and
expired releases before staging. Changing the signing key currently requires
controlled player re-enrollment; overlap/key-ID rotation is still required.
The Player stores the exact JSON bytes that were verified, the algorithm, the
signature, and a normalized playback view in one record. Boot recovery and
rollback reverify those exact bytes against the currently pinned key and screen,
then require the normalized view to match. Pre-upgrade unsigned records and
altered records are removed and produce a blank screen until a fresh signed
manifest arrives. A missing active marker never revives the previous slot.

The WebView cache-miss path permits at most 128 MiB per asset and 512 MiB per
manifest, downloads at most two assets concurrently, verifies exact size and
SHA-256 before activation, rechecks persistent entries before reuse and
playback, and prunes entries outside the active and rollback generations.
Native incremental hashing, stream-to-disk activation, quota
telemetry, and physical full-disk recovery evidence remain release gates.

The service worker has a separate, content-derived shell cache. The production
build injects the exact hashed JS/CSS outputs into its atomic install allowlist;
it intercepts only those paths and explicit same-origin shell files. Therefore
device API calls, media paths, cross-origin media, and the managed asset-cache
proxy are never intercepted. Activation removes only older shell generations
and does not touch the content cache used for verified active/rollback media.
Shell cache writes also require an exact non-redirected same-origin response and
the expected media type, preventing an SPA HTML fallback from being stored as a
script or style. A first-ever launch without a previously installed worker still
requires network access; native/WebView offline behavior remains a device gate.

Emergency manifests use priority `emergency`; the player visibly labels them. Normal schedules are restored by publishing a new normal manifest.

Automatic device-key rotation with old/new overlap, remote attestation, initial
enrollment fingerprint confirmation, verified deletion of a revoked Android
Keystore alias, offline media erasure, and proof that a replacement is the same
physical device remain outside proof-v1. Targeted re-enrollment adds a manual
exact-fingerprint approval step but does not close those gates. `securityLevel`
is self-reported diagnostic data, not attestation. A compromised trusted WebView
can still invoke the signing bridge, so proof-v1 protects an exported credential
from off-device use but is not a defense against execution inside the player
origin.
