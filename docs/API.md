# API overview

## Conventions

- Base path: `/api/v1` behind the reverse proxy.
- Payloads: UTF-8 JSON unless an upload endpoint documents otherwise.
- Time: RFC 3339 UTC timestamps at the API boundary; schedules retain an IANA time-zone name.
- IDs: opaque strings. Clients must not infer order or tenancy from them.
- Authentication: `Authorization: Bearer <token>` for users. Devices send `X-Screen-Id` and `X-Device-Token`. Credentials must not appear in URLs or logs.
- Errors: stable machine-readable code, safe human-readable message, and request ID. Validation errors may include field paths.
- Mutations that may be retried should accept an idempotency key. This is required before payment-like or emergency workflows are introduced.

Shared request and response shapes are defined in `packages/contracts`. The OpenAPI document generated or maintained by the API is the detailed endpoint authority once available.

## Main resource groups

| Group          | Purpose                                                          | Principal       |
| -------------- | ---------------------------------------------------------------- | --------------- |
| Authentication | Sign-in and current session                                      | User            |
| Screens        | Fleet inventory, state, tags, and assignment                     | User            |
| Media          | Asset metadata; binary upload is not yet implemented             | User            |
| Playlists      | Ordered media and durations                                      | User            |
| Schedules      | Time rules, priority, and targets                                | User            |
| Pairing        | Short-lived enrollment code exchange                             | User/device     |
| Device         | Pairing, heartbeat, and manifest delivery; commands are disabled | Device          |
| Emergency      | Expiring high-priority overrides                                 | Privileged user |
| Audit          | Security- and publishing-relevant events                         | Admin/auditor   |

## Authorization rules

Every user resource query must include the authenticated organization boundary. A caller-provided organization ID is never sufficient authorization. Devices are restricted to their own screen and current organization. Object keys must be server-generated and tenant-prefixed. Emergency activation requires a separately audited permission; district-wide two-person approval is a production requirement.

Media metadata creation and manifest publication are fail-closed: each URL origin must exactly match an explicitly configured allowlist entry. Production entries are origin-only HTTPS URLs using non-local DNS hostnames; URL credentials are rejected. The API stores metadata and does not fetch the URL. Players reject redirects while downloading binary assets. Web frames can still load navigation and subresources from their allowlisted entry point, and a hostname can later resolve to a private address, so web content needs a separately controlled content origin, DNS controls, and player-network egress policy before fleet use.

## Caching and consistency

Mutable management responses use `Cache-Control: no-store`. Published media may be immutable and long-lived when addressed by checksum. Manifests include a stable semantic version, envelope validity window, signed `withdrawn` state, optional signed `playbackEndsAt` schedule boundary, checksums, `signatureAlgorithm: Ed25519`, and a signature. Pairing pins `manifestVerificationKey`; a player verifies the signed envelope and screen binding, then activates only after every required asset has been verified. A normal-priority withdrawal with no items intentionally clears playback when no schedule or playable asset applies. Players may retain normal last-known-good playback past the routinely refreshed `validUntil` lease during an outage, but must stop it at `playbackEndsAt`.

## Health endpoints

- `GET /health/live` — process is running; must not depend on remote services.
- `GET /health/ready` — process can serve traffic and critical dependencies are reachable.

Health responses must not disclose credentials, connection strings, stack traces, or detailed topology.

## Compatibility policy

Additive fields are backwards-compatible and clients must ignore fields they do not understand. Removing or changing a field requires a versioned endpoint or a supported migration period. The oldest supported player release must be included in manifest compatibility tests before a server release.
