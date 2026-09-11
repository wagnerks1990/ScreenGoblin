# Supported-device validation matrix

## Status

**No production-supported device is declared.** Entries are planned validation targets, not certification, purchase advice, or evidence of compatibility. Record exact model/revision, OS/build, player/APK digest, management mode, test date, and retained artifacts for every result.

## Candidate classes

| Device/class                            | Intended role                                                  | Required validation                                                                                                      | Current status                     |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Onn 4K Pro / current development target | Consumer Google TV development and pilot evaluation            | HDMI modes, boot/reboot, storage pressure, WebView/media codecs, D-pad, network loss, power loss, LKG, kiosk limitations | **NOT VALIDATED / unsupported**    |
| Amazon Signage Stick candidate          | Managed signage evaluation subject to partner/API availability | Capability adapter, enrollment, managed updates, codecs, signage APIs, offline recovery, fleet policy                    | **NOT VALIDATED / unsupported**    |
| Managed AOSP signage player             | Capability-based managed fleet target                          | OEM management APIs, non-exportable identity, kiosk/boot, watchdog, signed updates/rollback, remote diagnostics          | **No approved model; unsupported** |
| Browser development player              | Development and deterministic test harness only                | Manifest/signature/hash/LKG behavior and responsive rendering                                                            | **Not a production player**        |

## Test profile required per exact device

| Area                        | Required scenarios                                                                                                                           | Evidence                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Identity                    | Keystore key creation/security level, public-key enrollment, challenge signing, replay/expiry rejection, rotate/revoke/factory-reset erasure | Instrumented logs/test artifact without private key or credential disclosure |
| Installation/update         | Signed APK install, boot receiver, app relaunch/watchdog, ring promotion, downgrade policy, failed update rollback                           | APK/certificate digest and timed outcome                                     |
| Display                     | 1080p/4K and supported portrait modes, overscan/safe area, text scale, HDMI sleep/wake/hotplug                                               | Photos/video with only synthetic content plus configuration record           |
| Input/accessibility         | D-pad-only pairing and recovery, focus visibility/order, screen-reader/contrast/reduced-motion behavior where supported                      | Test script and results                                                      |
| Media                       | Supported image/video codecs, frame pacing, audio policy, corrupt/oversize/unsupported assets, long-duration playback                        | Asset checksums, resource and playback measurements                          |
| Network/time                | Cold offline boot, DNS/TLS/API failure, captive portal, slow/flapping network, clock drift, certificate failure                              | Timeline proving bounded retry and continuous LKG playback                   |
| Storage/power               | Full disk, cache eviction, interrupted download/activation, abrupt power loss, repeated reboot                                               | Evidence of checksum verification, atomic activation, intact prior release   |
| Emergency-disabled behavior | Server feature disabled and malformed/stale emergency rejected without damaging normal baseline                                              | Test result; does not authorize emergency use                                |
| Telemetry                   | Heartbeat accuracy, stale/offline/fallback detection, privacy-minimized logs, no secret leakage                                              | API/device correlation report                                                |
| Endurance                   | Representative continuous playback and thermal/memory/storage observation                                                                    | Approved duration and acceptance thresholds TBD                              |

## Compatibility policy

- Support attaches to the exact hardware revision, firmware/OS build, management mode, and player version—not a marketing family name.
- Server releases must exercise the oldest supported player contract. Player releases promote through development, lab, pilot site, then broader rings with stop thresholds.
- Optional capabilities must be negotiated and absent controls hidden/disabled. Unsupported devices must never receive a command they cannot safely acknowledge.
- Vendor updates trigger focused regression and may suspend support. A failed mandatory safety/recovery test is a release blocker, not a documented caveat.
- Remote shell, camera/microphone collection, and unbounded arbitrary commands are out of scope.

## Approval record

The exact device inventory, minimum versions, owner, replacement/EOL policy, acceptance thresholds, test artifacts, security approval, operations approval, and pilot approval are all **TBD / NO-GO**.
