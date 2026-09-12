# ScreenGoblin AI context

## Product intent

ScreenGoblin makes multi-location digital signage simple for schools first while remaining suitable for other organizations. The product model is:

- **Content Studio** — templates, media, playlists, approval, publishing, and accessibility checks.
- **Operations Console** — screens, locations, health, diagnostics, updates, reports, users, and policy.
- **ScreenGoblin Player** — an Android-first, offline-capable, self-recovering playback endpoint.
- **Control plane** — identity, media, schedules, immutable releases, device enrollment, delivery, audit, and integrations.

The explicit scheduling model is: what plays = playlist; where = screen/location/group/tag; when = schedule. Priority order is normal, campaign, priority, emergency.

## Architecture invariants

- Players connect outbound over TLS and use unique credentials. The Android wrapper now creates a non-exportable Keystore identity key, but the current bearer credential remains authoritative; production requires server enrollment and replay-safe proof of possession.
- Manifests bind to a screen, carry a renewable envelope lease, and are signed with Ed25519. A signed normal withdrawal clears stale playback; an optional signed `playbackEndsAt` is the hard schedule boundary. Players pin the verification key during trusted enrollment and verify before staging.
- Non-web assets are bounded, size/hash verified, and cache-pruned around atomic activation. Emergency overlays never enter the normal rollback chain, and stale callbacks may not roll back a newer active version.
- Live operational data must fail visibly. Never replace a failed authenticated request with demo values.
- Published content, schedules, commands, permissions, emergencies, and device lifecycle operations require durable audit coverage.
- Tenant-owned database relationships must carry and enforce the same organization ID at the foreign-key boundary; migrations must abort for investigation rather than silently relabel cross-tenant legacy rows.
- Production media must match an explicit canonical HTTPS origin. Direct player delivery still requires controlled DNS and egress because hostname allowlisting alone cannot prevent rebinding to private addresses.
- Remote shell is not a default capability. Any future implementation needs explicit authorization, consent, scope, expiry, strong audit, and product-level review.

## Deliberately disabled or incomplete

Emergency activation, remote commands, screenshots, proof of play, uploads/scanning, immutable approval releases, scoped location authorization, MFA/SSO, update rings, and server-bound Keystore proof of possession are not complete release capabilities. Do not create UI or documentation that implies otherwise.

## AI boundaries

AI may draft copy, suggest templates/tags/schedules, summarize device health, and assist diagnosis. A human must approve publishing and device actions. AI may never autonomously publish, operate devices, activate/clear/extend an emergency, make destructive fleet decisions, or perform camera-based demographic inference.

## Quality gate

Run `npm run validate`; CI additionally runs the destructive-guarded PostgreSQL integration suite. Continue expanding scoped authorization and immutable release integrity, browser accessibility/E2E tests, Android tests, native stream-to-disk caching, DNS/egress enforcement, offline/emergency recovery tests, and physical-device evidence as the corresponding features mature. Green automated tests alone do not establish pre-production readiness.
