# ScreenGoblin Player

Offline-first signage runtime for Android TV, HDMI dongles, Chromium kiosks, and installable PWA clients.

## Guarantees

- A downloaded image or video is activated only after byte length and SHA-256
  validation succeed. Persistent cache hits are revalidated before reuse and
  immediately before playback.
- A manifest is promoted only after every required binary asset is safely cached.
- The exact signed manifest bytes remain with each active/rollback record and
  are reverified against the pinned key and screen before boot recovery or
  promotion. Legacy unsigned or altered records fail closed.
- A locally eligible prior signed manifest remains available for explicit
  playback rollback. Accepting a signed withdrawal atomically removes that
  rollback slot, and expired playback or asset boundaries cannot be crossed;
  a missing or corrupt active marker never promotes an older release.
- Existing content continues when the API is unavailable. Connectivity status stays unobtrusive in the lower corner.
- Signed withdrawals and signed schedule boundaries blank content without reviving an older schedule; stale poll and rollback callbacks cannot overwrite a newer version. A bounded wall-clock watcher rechecks hard boundaries at least every 30 seconds and when the WebView resumes, while an independent countdown prevents a backward clock correction from extending the lifetime calculated when playback began.
- Android streams binary cache misses into app-private staging files, verifies
  the signed byte length and SHA-256 while writing, then atomically publishes
  the completed file. Partial or mismatched files are removed and cannot become
  playable. Native available-storage telemetry is exposed to the WebView, and
  pruning retains only assets referenced by active and rollback generations.
- Browser/PWA development keeps the bounded CacheStorage implementation. During
  Android upgrade, an explicit native `CACHE_MISS` may resolve a retained legacy CacheStorage
  entry only after rechecking its exact size and SHA-256; ordinary new
  prefetches always use the native cache. The data-URL emergency fixture stays
  on the legacy verifier only in non-production builds where emergency support
  is explicitly enabled.
- Web media is disabled in the metadata-only pilot.

The current API/player integration supports codes bound to a precreated tenant
screen and the current issuing administrator's identity epochs,
authenticated heartbeats, and signed schedule manifests. The Android wrapper now
creates a non-exportable P-256 identity key in Android Keystore and exposes only
its public key and challenge-signing operation to the WebView. The server enrolls
that public key through a two-stage transcript-bound exchange and requires a
fresh, one-use, operation- and body-bound proof for each heartbeat and manifest.
Production proof mode issues no bearer token. Remote device commands remain
disabled. The Android wrapper contains a native-only journal in app-private
preferences that recognizes exactly `REFRESH_CONTENT` and `RESTART_RENDERER`,
uses lexicographic credential-generation and per-generation sequence ordering,
atomically supersedes every older-generation pending or terminal state when a
higher generation arrives, and rejects rollback and conflicting replay. Restart
completion requires an explicit trusted native ready signal from a different
renderer lifecycle; bridge JavaScript cannot assert readiness, and plugin reload
alone does not report success. The trusted native lifecycle integration is not
implemented, so the staged restart remains pending. The plugin is deliberately
not registered with the current Capacitor bridge, no server response or Player
JavaScript can invoke it, no command API or polling route exists, and the Console
continues to offer no command action. `SharedPreferences.commit()` gives this
substrate a synchronous Android API-level replace result, but a false return or
exception does not prove whether Android's in-memory preferences changed. The
journal then poisons that storage namespace for the rest of the process: every operation
returns `STATE_UNCERTAIN` without reading it. A process restart clears only the
in-memory poison; the journal then accepts an exact valid stored snapshot and
fails closed with `STATE_CORRUPT` otherwise. Clearing application data is a
manual destructive reset that also erases replay high-water state, and a running
poisoned process must still be restarted. None of this is evidence of physical
power-loss durability, encrypted or hardware-backed storage, privileged rollback
resistance, or state survival after application data is cleared. Server
authorization, signed delivery, expiry, audit, capability negotiation,
proof-authenticated acknowledgement, trusted native readiness integration, and
representative device lifecycle/power-loss testing must land together before
this substrate can be reached.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
npm test
npm run build
```

The API must expose the contract documented in
[`docs/DEVICE_PROTOCOL.md`](../../docs/DEVICE_PROTOCOL.md). Serve asset URLs
with CORS enabled. Asset `sizeBytes` and `checksumSha256` must describe the exact
response bytes delivered to the native downloader. Publication, Android native
download, and browser/PWA cache misses currently retain the 128 MiB per-asset
ceiling; manifests retain the 512 MiB aggregate ceiling. Native
`availableBytes` telemetry additionally reflects the device's safe writable
capacity after reservations.

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
transactional OWNER/ADMIN revocation. Server-verified attestation, automatic
overlapping credential/key rotation, offline recall, verified local erasure,
and representative physical-device validation remain release gates.

The native cache implementation does not by itself close the release gate for
representative low-space/full-disk operation, process death or power loss during
download and rename, storage accounting across supported Android versions, or
verified media erasure after revocation. Capture that evidence on production
hardware before fleet rollout.

Deterministic clock-jump tests cover local forward and backward corrections for
signed playback deadlines. They do not provide a trusted time source, prove
behavior across device sleep/firmware combinations, or close the physical-device
clock-drift gate.

Initial enrollment and manual targeted re-enrollment both stage the proved key
for current OWNER/ADMIN exact-fingerprint activation before it can authenticate.
Initial activation attaches the key to the precreated Screen and leaves it
offline until its first authenticated heartbeat. Manual targeted re-enrollment requires an explicit local action before the
Player replaces its prior Keystore identity with a fresh P-256 key. Fresh-key
proof returns a pending candidate and fingerprint; the key cannot authenticate
until a later current OWNER/ADMIN action confirms that exact fingerprint and
activates it for the existing screen. Pairing failures and ordinary enrollment
must never silently rotate the native identity. This zero-overlap recovery path
does not implement automatic rotation, attestation, offline recall, or verified
erasure; those remain release gates.

Release APKs must use a protected signing key in CI. Never commit signing credentials. Production API URLs must use HTTPS; cleartext traffic is disabled.
