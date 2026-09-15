# ScreenGoblin contributor and agent guidance

ScreenGoblin is an Android-first digital-signage platform with three product surfaces: Content Studio and Operations Console modules in `apps/console`, the control-plane API in `apps/api`, and the Android/web player in `apps/player`.

## Non-negotiable safety boundaries

- Treat `docs/PREPRODUCTION.md` and `docs/reviews/preproduction-audit.md` as release gates. Never represent an unchecked gate as complete.
- Keep emergency publishing disabled unless the full approval, MFA, acknowledgement, partial-delivery, expiry, recovery, and tabletop requirements are implemented and evidenced. ScreenGoblin is not a life-safety system.
- AI is assistive only. It must not publish, activate or clear emergencies, operate devices, override approvals, or replace deterministic scheduling and manifest generation.
- Preserve tenant isolation, server-side authorization, append-only audit intent, outbound-only player connections, signed manifests, last-known-good playback, bounded emergency expiry, and rollback safety.
- Do not place credentials, school-specific infrastructure, student information, signing keys, private URLs, or production `.env` values in source, tests, logs, screenshots, documentation, or chat output.
- Do not expose PostgreSQL, Redis, MinIO, the Caddy admin API, or management-only services publicly.

## Required workflow

1. Read the root README, relevant package README, security/threat-model documents, protocol documents, changelog, and tests before editing.
2. Use a focused branch. Preserve unrelated changes and backward-compatible identifiers unless a reviewed migration exists.
3. Add failure-path, tenant-boundary, offline/recovery, and security regression tests with behavior changes.
4. Run `npm ci` and `npm run validate`. For Android changes, also run the Gradle lint/unit/debug build tasks.
5. Update the API/device contracts, runbook, threat model, changelog, and AI context when behavior or architecture changes.
6. Do not disable or weaken a failing test or security check to obtain a green build.

## Brand and UX

`packages/brand/src/tokens.json` is the code-facing design source of truth. Keep the interface professional and dark-first, use non-color status cues, meet WCAG-oriented contrast, and reserve mascot art for onboarding, empty, marketing, and selected success states. Operational errors, offline behavior, player failures, and security copy must remain precise.

`docs/UX_REFERENCE.md` and the SVG files under `packages/brand/reference/` are the approved ScreenGoblin layout and workflow references. Use only ScreenGoblin-specific reference renderings for this repository; never use Herd Store, LabGoblin, RoomGoblin, PatchGoblin, or unrelated project imagery as implementation reference. Renderings are conceptual UX references and must not be treated as evidence that a feature is implemented. SVG is a repository design-artifact format only and does not enable SVG/web content in the Player media pipeline.

## Current release status

Version `0.1.x` is a constrained prototype. Only a non-PII, non-life-safety pilot on an isolated signage VLAN is permitted. Unsupported controls must be hidden or visibly disabled; demo data must never be silently substituted for failed live data.
