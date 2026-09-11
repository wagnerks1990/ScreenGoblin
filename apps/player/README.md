# ScreenGoblin Player

Offline-first signage runtime for Android TV, HDMI dongles, Chromium kiosks, and installable PWA clients.

## Guarantees

- A downloaded image or video is activated only after byte length and SHA-256 validation succeed.
- A manifest is promoted only after every required binary asset is safely cached.
- The prior manifest remains available for automatic playback rollback.
- Existing content continues when the API is unavailable. Connectivity status stays unobtrusive in the lower corner.
- Web items are sandboxed but inherently require connectivity unless the remote application implements its own caching. Do not use web items as the only emergency or fallback content.

The current API/player integration supports admin-created pairing codes,
authenticated heartbeats, and signed schedule manifests. The Android wrapper now
creates a non-exportable P-256 identity key in Android Keystore and exposes only
its public key and challenge-signing operation to the WebView. The current
server does not enroll that public key or verify proof of possession, so the
bearer credential remains authoritative and this is not yet production device
authentication. Remote device commands remain disabled until their server-side
authorization, persistence, expiry, and replay controls are implemented.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
npm test
npm run build
```

The API must expose the contract documented in [docs/PLAYER_PROTOCOL.md](docs/PLAYER_PROTOCOL.md). Serve asset URLs with CORS enabled. Asset `sizeBytes` and `checksumSha256` must describe the exact response bytes (after any server-side content encoding is decoded by Fetch).

## Android

The checked-in Capacitor project keeps Android builds deterministic. Requirements: JDK 21 and Android SDK 35.

```bash
npm run android:sync
cd android
./gradlew assembleDebug
```

`MainActivity` requests immersive mode and lock-task mode when the app is allowlisted by a device owner. `BootReceiver` asks Android to reopen the player after boot. Android 10+ can restrict background activity launches; production hardware should additionally configure ScreenGoblin as the device-owner kiosk/home application using its EMM, OEMConfig, or provisioning API. The receiver is a recovery aid, not a substitute for managed-device policy.

New Android installations use the SHA-256 fingerprint of the Keystore public
key as their installation ID. Existing locally stored installation IDs are
preserved to avoid breaking already-paired prototypes. Browser/PWA installations
continue using a persisted random UUID. A production enrollment flow must bind
the public key to the screen, verify fresh server challenges, support rotation
and revocation, and verify local erasure during decommissioning.

Release APKs must use a protected signing key in CI. Never commit signing credentials. Production API URLs must use HTTPS; cleartext traffic is disabled.
