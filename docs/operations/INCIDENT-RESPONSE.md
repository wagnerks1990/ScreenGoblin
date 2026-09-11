# Incident response plan

## Status

**Draft template — contacts, notification rules, evidence systems, and exercises are unapproved. NO-GO for production.** Populate and tabletop this plan before any real pilot. ScreenGoblin is not the authoritative emergency-notification system.

## Roles

| Role                 | Responsibility                                                  | Named coverage |
| -------------------- | --------------------------------------------------------------- | -------------- |
| Incident commander   | Own severity, coordination, decisions, timeline, and handoff    | TBD            |
| Operations lead      | Stabilize service/player fleet, deploy or roll back             | TBD            |
| Security lead        | Contain compromise, preserve evidence, lead credential response | TBD            |
| Privacy/records lead | Determine data impact, retention, and notification obligations  | TBD            |
| Communications lead  | Approved internal/customer/status updates                       | TBD            |
| Product/pilot owner  | Assess operational impact and safe degraded mode                | TBD            |
| Scribe               | Timestamp actions, evidence IDs, hypotheses, and decisions      | TBD            |

No single operator should investigate and approve destructive organization-wide actions without review. Use an out-of-band channel if ScreenGoblin identity or communications are suspect.

## Severity and initial objectives

| Severity | Examples                                                                                                                                 | Initial objective (proposal)                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| SEV-1    | Unauthorized/false emergency content, publishing compromise, multi-tenant exposure, signing-key compromise, widespread malicious content | Acknowledge within 15 minutes; contain immediately; executive/security/privacy escalation |
| SEV-2    | Organization-wide publishing outage, widespread stale/fallback players, material data loss, restore required                             | Acknowledge within 30 minutes; stabilize cached playback and bound impact                 |
| SEV-3    | Single-site or noncritical degradation with working fallback                                                                             | Acknowledge within 4 business hours; preserve service and schedule correction             |
| SEV-4    | Cosmetic defect or low-risk operational issue                                                                                            | Normal triage and documented prioritization                                               |

Objectives are targets only until staffed coverage and monitoring are approved. Do not claim an SLO from this table.

## Response sequence

1. **Declare:** assign incident ID, commander, severity, start time, affected organizations/screens, reporter, and trusted coordination channel.
2. **Preserve:** snapshot relevant audit/log identifiers, versions, digests, timestamps, and configuration. Do not copy secrets or prohibited content into tickets/chat.
3. **Contain:** disable affected release path, revoke compromised sessions/devices, block malicious objects, or isolate service while preserving last-known-good playback.
4. **Eradicate:** correct the root cause, rotate affected secrets/keys using the approved ceremony, scan dependencies/images, and remove unauthorized access.
5. **Recover:** restore from verified sources, promote through rings, compare expected release/manifest digests, and monitor for recurrence.
6. **Communicate:** provide factual time-stamped impact and recovery updates through approved channels; never use ScreenGoblin itself as the only incident channel.
7. **Review:** within the approved interval, document timeline, root cause, contributing controls, impact, detection gaps, corrective owners/dates, and evidence retention.

## Priority playbooks

### Unauthorized or emergency content

- Use the authoritative out-of-band safety/communications process first.
- Disable emergency publishing if safely possible; revoke implicated user/device sessions and freeze affected release candidates.
- Identify exact target expansion, approvals, manifest/release digests, delivery and acknowledgement state.
- Restore the last trusted normal release without deleting evidence. Notify safety leadership because some screens may be offline or partially delivered.

### Suspected identity/signing compromise

- Revoke affected credentials and stop new publication/enrollment.
- Treat signing-key compromise as fleet-wide until scope is proven; do not rotate without an overlap/recovery plan that prevents lockout or downgrade.
- Review authentication, approval, pairing, audit, CI, secret-store, and artifact-provenance events.

### Tenant exposure

- Stop the affected endpoint/job, preserve request/audit IDs, and identify object/tenant boundaries without broadening access.
- Engage privacy/legal ownership for scope and notification decisions.
- Add a negative tenant-boundary regression and validate database constraints before reopening.

### Control-plane or data loss

- Preserve cached playback and avoid unreviewed emergency/manual workarounds.
- Determine the last verified backup, application/schema compatibility, object consistency point, and deletion/revocation reconciliation needs.
- Restore only into isolation first; compare checksums and reconstruct a sample signed manifest before production recovery.

## Minimum incident record

Incident ID; severity; commander; affected scope; first/last known times; source of detection; source/image/APK/config digests; decisions and approvers; request/audit/evidence IDs; containment/recovery actions; communication log; data assessment; remaining risk; corrective owners/dates. Store it in an approved restricted system, not the repository.

## Readiness evidence

Named/on-call coverage, escalation paths, provider contacts, communication templates, log access, credential/key rotation exercises, restore exercise, unauthorized-publish exercise, tenant-exposure exercise, and emergency partial-delivery tabletop are all **not evidenced by this template**.
