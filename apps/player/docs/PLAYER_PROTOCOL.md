# Player protocol

Initial pairing is relative to the configured server URL. The pairing response returns the device API base URL. Authenticated calls send `X-Screen-Id` and `X-Device-Token`; neither value belongs in a URL or log.

| Method | Endpoint                       | Purpose                                           |
| ------ | ------------------------------ | ------------------------------------------------- |
| POST   | `/api/v1/device/pair`          | Consume an admin-created short-lived pairing code |
| GET    | `{deviceApiBaseUrl}/manifest`  | Fetch this screen's fully resolved manifest       |
| POST   | `{deviceApiBaseUrl}/heartbeat` | Report actual player and playback state           |

Remote device commands are intentionally not enabled in the current prototype. They require persistent command records, expiry, authorization, replay resistance, idempotent acknowledgement, and hardware capability checks before activation.

The manifest includes `version`, `generatedAt`, `validUntil`, `screenId`, `priority`, and ordered playlist `items`. Each playlist item contains an `asset` plus `durationSeconds`; the player normalizes that wire shape before staging. Image, video, and template checksums are mandatory. URLs should be immutable or short-lived signed URLs whose content bytes stay stable for the URL lifetime.

Emergency manifests use priority `emergency`; the player visibly labels them. Normal schedules are restored by publishing a new normal manifest. Device authentication tokens should be independently revocable and rotated by the server.
