# ScreenGoblin Player

Offline-first signage runtime for Android TV, HDMI dongles, Chromium kiosks, and installable PWA clients.

## Guarantees

- A downloaded image or video is activated only after byte length and SHA-256 validation succeed.
- A manifest is promoted only after every required binary asset is safely cached.
- The prior manifest remains available for automatic playback rollback.
- Existing content continues when the API is unavailable. Connectivity status stays unobtrusive in the lower corner.
- Signed withdrawals and signed schedule boundaries blank content without reviving an older schedule; stale poll and rollback callbacks cannot overwrite a newer version.
- Cache-miss verification is limited to 128 MiB per asset and 512 MiB per manifest, with two concurrent downloads and active/rollback generation pruning. Larger media requires the planned native incremental hash/stream-to-disk path.
- Web items are sandboxed but inherently require connectivity unless the remote application implements its own caching. Do not use web items as the only emergency or fallback content.

The current API/player integration supports admin-created pairing codes,
authenticated heartbeats, and signed schedule manifests. The Android wrapper now
creates a non-exportable P-256 identity key in Android Keystore and exposes only
its public key and challenge-signing operation to the WebView. The server enrolls
that public key through a two-stage transcript-bound exchange and requires a
fresh, one-use, operation- and body-bound proof for each heartbeat and manifest.
Production proof mode issues no bearer token. Remote device commands remain
disabled until their server-side authorization, persistence, expiry, and replay
controls are implemented.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
npm test
npm run build
```

The API must expose the contract documented in [docs/PLAYER_PROTOCOL.md](docs/PLAYER_PROTOCOL.md). Serve asset URLs with CORS enabled. Asset `sizeBytes` and `checksumSha256` must describe the exact response bytes (after any server-side content encoding is decoded by Fetch). Cache-miss assets above 128 MiB and manifests above 512 MiB are rejected until native streaming verification exists.

## Android

The checked-in Capacitor project keeps Android builds deterministic. Requirements: JDK 21 and Android SDK 35.

```bash
npm run android:sync
cd android
./gradlew assembleDebug
```

`MainActivity` requests immersive mode and lock-task mode when the app is allowlisted by a device owner. `BootReceiver` asks Android to reopen the player after boot. Android 10+ can restrict background activity launches; production hardware should additionally configure ScreenGoblin as the device-owner kiosk/home application using its EMM, OEMConfig, or provisioning API. The receiver is a recovery aid, not a substitute for managed-device policy.

Android installations use the SHA-256 fingerprint of the Keystore public key as
their installation ID; a legacy browser UUID cannot override it. Browser/PWA
installations continue using a persisted random UUID and may use bearer
authentication only in an explicit localhost development build. Proof-v1 binds
the public key to the screen, verifies fresh server challenges, and supports
transactional OWNER/ADMIN revocation. Server-verified attestation, credential/key
rotation, targeted re-enrollment, offline recall, and verified local erasure
during decommissioning remain release gates.

Release APKs must use a protected signing key in CI. Never commit signing credentials. Production API URLs must use HTTPS; cleartext traffic is disabled.
