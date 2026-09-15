# Required approvals and release authority

## Status

**Template only — no approvals are recorded by this file. The current decision is NO-GO.** Names, evidence links, dates, scope, conditions, and expiry must be entered in the controlled release record by authorized humans.

## Separation of responsibilities

| Decision                                 | Required accountable roles                                                               | Minimum evidence                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Limited pilot scope                      | Product owner, security owner, privacy/records owner, operations owner, pilot-site owner | Scope, data profile, network review, support plan, go/no-go record                                                          |
| Production release                       | Product, security, privacy/legal, operations, and service ownership                      | Completed release gates, independent testing, signed artifacts, recovery evidence, risk register                            |
| Publishing ordinary content              | Scoped publisher; additional approver when policy requires                               | Immutable revision, target/time preview, accessibility review, audit record                                                 |
| Organization-wide or priority publishing | Scoped publisher plus independent approver                                               | Release candidate, exact targets, conflict result, two distinct identities, expiry when applicable                          |
| Emergency feature enablement             | Executive/safety authority, security, operations, product                                | MFA, separate permission, two-person approval, acknowledgements, partial-delivery handling, expiry/recovery tests, tabletop |
| Emergency activation/extension/clear     | Two authorized humans using strong re-authentication                                     | Exact message/targets/expiry, distinct approvals, delivery status, immutable audit                                          |
| High-risk device action                  | Scoped operator plus approver according to action                                        | Device set, bounded command, expiry, rollout ring, acknowledgement/rollback plan                                            |
| New vendor/subprocessor/integration      | Privacy/legal, security, data owner, product                                             | Data-flow update, contract/DPA, access, retention/deletion, incident terms                                                  |
| Retention exception/legal hold           | Records/privacy/legal owner and security owner                                           | Case ID, data scope, custody, review/expiry date                                                                            |
| Security risk acceptance                 | Accountable service/product executive and security owner                                 | Finding, severity, compensating controls, owner, deadline, review date                                                      |

## Approval validity rules

- For the implemented ordinary release-candidate workflow, the candidate author
  and approver must be distinct people, and only a current `OWNER` or `ADMIN`
  may approve. A `PUBLISHER` may create, submit, publish, and withdraw but cannot
  approve. The later publisher may be the author,
  the approver, or a third authorized person; therefore the guaranteed two-person
  property is author-versus-approver, not three-person separation. A role label,
  shared account, AI, service identity, or repeated session is insufficient.
- The current implementation applies this rule organization-wide. It does not
  yet establish location, group, or screen-scoped grants, MFA/re-authentication,
  emergency approval, or completion of the production go/no-go record.
- Approval binds to an immutable digest of the revision, target selector expansion, schedule/expiry, policy result, and release candidate. Any material change invalidates approval.
- Approval must be explicit, time-bounded, authenticated, auditable, and made after viewing the exact proposed effect.
- Absence, timeout, service failure, stale approval, conflict, or ambiguity fails closed.
- AI, automation, service accounts, and device identities cannot provide human approval, satisfy separation of duty, or override a denial.
- Emergency approval never converts ScreenGoblin into a life-safety system and never replaces authoritative emergency channels.

## Go/no-go record template

| Field                                                    | Required value      |
| -------------------------------------------------------- | ------------------- |
| Release/version and immutable source/image/APK digests   | TBD                 |
| Environment and approved tenant/site scope               | TBD                 |
| Data classification and retention profile                | TBD                 |
| Open exceptions, owners, compensating controls, expiries | TBD                 |
| Product owner decision/signature/date                    | **NO-GO — missing** |
| Security owner decision/signature/date                   | **NO-GO — missing** |
| Privacy/records/legal decision/signature/date            | **NO-GO — missing** |
| Operations owner decision/signature/date                 | **NO-GO — missing** |
| Pilot-site/business owner decision/signature/date        | **NO-GO — missing** |
| Rollback owner and maintenance/support window            | TBD                 |

Repository checkboxes, CI success, issue closure, or a merged pull request are engineering evidence only. None substitutes for these approvals.
