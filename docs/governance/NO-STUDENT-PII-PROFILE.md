# No-student-PII pilot profile

## Status and boundary

**Mandatory pilot restriction; not a production privacy approval.** ScreenGoblin may be evaluated only with public or synthetic signage and minimal authorized staff account data. It must not be treated as a student record system, emergency authority, safety system, or audience-surveillance platform.

## Allowed data

- Publicly approved school or organization messages that identify no student, visitor, or private individual.
- Synthetic/test media and template content.
- Minimal staff administrator name, work email, role, and security audit attribution, subject to organizational approval.
- Non-personal screen labels, coarse approved location labels, software/device versions, storage availability, heartbeat time, and manifest state.
- Security telemetry minimized to what is necessary for abuse detection and incident response.

## Prohibited data and features

- Student names, usernames, IDs, photographs, voices, work, grades, attendance, behavior, disability/health information, schedules, transportation details, or directory information.
- Rosters or integrations with SIS, LMS, identity, cafeteria, library, visitor, camera, access-control, or student communication systems.
- Visitor/staff personal schedules, private messages, individualized recognition, missing-person notices, or disciplinary/safety details.
- Camera/microphone capture, facial or emotion recognition, audience measurement, demographic inference, proximity tracking, advertising profiles, or precise device-user location.
- Screenshots, proof images, crash dumps, logs, filenames, QR codes, URLs, or AI prompts containing prohibited data.
- AI generation, classification, summarization, or moderation of student/private data.

## Required controls

- Keep upload and integration features disabled until content validation, malware scanning, private delivery, authorization, retention, and approval exist.
- Use synthetic fixtures and generic location names in development, CI, demos, support bundles, and screenshots.
- Limit screens to a dedicated signage VLAN and prohibit inbound player management.
- Display an operator warning at content entry/publish surfaces when those surfaces are implemented.
- Train pilot operators to remove content immediately and notify the incident lead if prohibited data appears.
- Do not infer privacy compliance from technical filtering: human review and organizational policy remain required.

## Pre-pilot verification record

| Check                                                                          | Evidence owner | Status                    |
| ------------------------------------------------------------------------------ | -------------- | ------------------------- |
| Content inventory contains only public/synthetic material                      | TBD            | **NO-GO — not evidenced** |
| Accounts are approved staff-only identities                                    | TBD            | **NO-GO — not evidenced** |
| Screenshots, surveillance, analytics, and unapproved integrations are disabled | TBD            | **NO-GO — not evidenced** |
| Operators received the prohibited-data procedure                               | TBD            | **NO-GO — not evidenced** |
| Privacy/security/product owners accepted the limited pilot                     | TBD            | **NO-GO — not approved**  |

Any failed check stops the pilot. A request to use student or other sensitive data requires a separately reviewed architecture, policy, contract, consent/notice analysis, access model, retention implementation, incident process, and explicit written approval; this profile cannot grant that permission.
