# SLO and alerting proposal

## Status

**Draft targets — unapproved and not backed by production measurements. NO-GO for production claims.** Final objectives require capacity tests, representative hardware, staffed response, monitoring ownership, and an agreed measurement window.

## Proposed service indicators

| Capability        | Indicator                                                                      | Proposed objective               | Important exclusions/notes                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated API | Successful eligible requests / eligible requests                               | 99.9% over 28 days               | Exclude explicit client validation/auth failures; include dependency failures and server throttling errors caused by undersizing |
| Manifest service  | Valid signed manifest responses within 2 seconds                               | 99.9% over 28 days               | Measure server-side and from representative player networks                                                                      |
| Publishing        | Accepted ordinary release candidates reaching terminal success/failure         | 99.5% within 5 minutes           | Target model not yet implemented; emergency is excluded and disabled                                                             |
| Fleet freshness   | Expected online players with heartbeat received within configured stale window | 99% during site operating hours  | Requires approved maintenance/site calendars and device population                                                               |
| Cached playback   | Players continuing last-known-good content during control-plane/network loss   | 99.9% of observed outage minutes | Must be validated per supported hardware/storage/power scenario                                                                  |
| Recovery          | Restore of database/object set to verified isolated service                    | RPO ≤24h, RTO ≤8h proposal       | Not approved; off-host backup and timed restore evidence incomplete                                                              |

Do not average away organization/site outages. Segment indicators by environment, tenant, player version, device class, and release ring while limiting label cardinality and personal data.

## Alert design

| Alert                        | Trigger concept                                                                    | Routing                                          | Runbook action                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| API error-budget burn        | Fast and slow multi-window burn of API/manifest SLO                                | Operations; security when auth/publish anomalous | Inspect dependency health, request IDs, releases; roll back schema-compatible change      |
| Readiness/dependency failure | Sustained API readiness failure or DB/Redis/storage unavailability                 | Operations                                       | Keep players on cached content; restore dependency or prior release                       |
| Manifest/signature failure   | Any sustained signing/build failure or player verification spike                   | Operations + security                            | Stop promotion; inspect key ID/digest/time and preserve last-known-good                   |
| Authentication/pairing abuse | Distributed failure/rate-limit anomaly above calibrated baseline                   | Security                                         | Identify source/account/code class using privacy-minimized keys; revoke/contain as needed |
| Tenant authorization anomaly | Cross-tenant denial/assertion, unexpected grant evaluation, or audit mismatch      | Security SEV-1/2                                 | Freeze affected path; preserve evidence; test scope and constraints                       |
| Fleet stale/fallback         | Site/ring stale or fallback percentage exceeds approved threshold                  | Fleet operations/site owner                      | Check network/power/release; stop rollout; retain cached playback                         |
| Storage/capacity             | Forecast exhaustion for DB/object/player disk, failed cleanup, backup too old      | Operations                                       | Stop risky uploads/releases; expand or remediate safely                                   |
| Backup/restore               | Backup checksum/age failure or scheduled drill failure                             | Operations + security                            | Repair pipeline; do not approve release/recovery evidence                                 |
| Emergency event              | Attempt, activation, approval failure, partial acknowledgement, approaching expiry | Staffed safety/operations/security channels      | Use authoritative out-of-band process; never rely on ScreenGoblin alone                   |

## Telemetry constraints

- Metrics must not contain tokens, pairing codes, content payloads, email addresses, signed URLs, object keys with personal names, or unbounded IDs.
- Logs use request/event IDs with server-side access controls and approved retention. Redact authorization headers and secrets at ingestion.
- Liveness is process-local; readiness checks critical dependencies without exposing topology publicly.
- Synthetic probes use isolated test identities/content and may not publish to real screens.
- Alert delivery needs deduplication, ownership, acknowledgement, escalation, maintenance windows, and a tested out-of-band fallback.

## Release criteria for these targets

- Dashboards and queries are version-controlled or reviewed.
- Each alert fires in a controlled test and links to a usable runbook.
- Capacity/load and failure-injection tests establish thresholds and false-positive rate.
- Representative devices report end-to-end playback/fallback measurements.
- At least one full observation window is reviewed, with exclusions and outages documented.
- Product, operations, security, and pilot owners approve objectives and coverage. These criteria are currently **not complete**.
