# ScreenGoblin UX reference

This document records the approved ScreenGoblin interface direction for future implementation work.

## Scope

The ScreenGoblin reference set covers four primary Operations Console surfaces:

1. **Operations dashboard** — fleet health, screens needing attention, current-content previews, and recent operational activity.
2. **Screen fleet and device details** — screen status, filtering, pairing, playback state, and device information.
3. **Playlists and content organization** — playlist cards, ordered content, durations, previews, and screen assignments.
4. **Scheduling and programming** — weekly/day scheduling, recurring playback windows, schedule details, and upcoming events.

The reference renderings were created specifically for ScreenGoblin. Do not use Herd Store, LabGoblin, RoomGoblin, or unrelated project renderings as ScreenGoblin UX references.

## Design direction

The reference direction is intentionally consistent with the repository's existing brand contract:

- dark-first ScreenGoblin operations interface;
- ScreenGoblin green as the principal accent;
- charcoal/midnight surfaces with restrained status colors;
- compact left-side navigation and information-dense but readable work areas;
- status communicated with text/icons in addition to color;
- operational information prioritized over decorative analytics;
- responsive layouts suitable for desktop administration and smaller management screens.

`packages/brand/src/tokens.json` remains the code-facing source of truth for exact colors, typography, spacing, and component tokens. Reference imagery establishes layout, hierarchy, workflow, and visual direction; it does not override accessibility, security, safety, or implemented product behavior.

## Reference screens

The approved conceptual image set is:

- `01-dashboard.png` — Operations dashboard
- `02-screen-fleet.png` — Screen fleet and device detail
- `03-playlists.png` — Playlists and content organization
- `04-schedules.png` — Scheduling and programming

These images are design references rather than screenshots of deployed functionality. Sample counts, names, schedules, and content shown in a rendering are illustrative and must not be interpreted as implemented API behavior or production data.

## Implementation rules

When implementing or reviewing ScreenGoblin UI work:

- use these ScreenGoblin concepts as the preferred layout/workflow reference;
- preserve the explicit mental model of **what plays = playlist**, **where it plays = screen/group/location**, and **when it plays = schedule**;
- keep fleet health, offline/fallback state, last-seen information, and recovery-relevant details prominent;
- keep unsupported prototype controls hidden or visibly disabled;
- never silently substitute demo data after live-data failure;
- preserve precise operational and security copy;
- keep emergency functionality isolated and disabled until the repository's pre-production emergency gates are satisfied;
- treat AI as assistive only and never allow it to publish, activate emergency behavior, or issue destructive device commands autonomously.

## Binary image storage

The approved PNG renderings are maintained as project design artifacts. If a GitHub editing client cannot commit binary files, add the four PNG files under `docs/assets/ux-reference/` from the approved ScreenGoblin rendering set and retain the exact filenames above. Do not substitute generated images from another Goblin project.
