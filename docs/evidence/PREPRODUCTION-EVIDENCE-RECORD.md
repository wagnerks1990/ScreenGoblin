# Pre-production evidence record

## Decision

**NO-GO — template only.** This record contains no approval, no completed physical-device test, no production signing evidence, and no external governance acceptance. CI success or a merged change cannot change this status by itself.

## Candidate identity

| Field                                                       | Recorded value |
| ----------------------------------------------------------- | -------------- |
| Version/tag                                                 | TBD            |
| Source commit/tree digest                                   | TBD            |
| API image digest                                            | TBD            |
| Console image digest                                        | TBD            |
| Player image/APK digest and signing certificate fingerprint | TBD            |
| Packaged manifest report and APK/manifest hashes            | TBD            |
| SBOM/provenance/signature references                        | TBD            |
| Database migration range and compatibility                  | TBD            |
| Environment, tenant, sites, and device ring                 | TBD            |
| Evidence window/date                                        | TBD            |
| Evidence custodian                                          | TBD            |

## Evidence matrix

Record immutable URLs/artifact IDs, timestamps, tool versions, scope, result, reviewer, and accepted exceptions. Never paste credentials, private URLs, student data, or school-specific infrastructure into this repository.

| Gate              | Required evidence                                                                                                              | Result                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Source quality    | Clean checkout install, format, lint, typecheck, unit/integration/build and coverage report                                    | **NOT RECORDED**                |
| Tenant/security   | PostgreSQL-backed positive/negative isolation tests, scoped authorization, transactional audit, session/device revocation      | **NO-GO**                       |
| Supply chain      | Dependency/secret/CodeQL/DAST/container scans, SBOM, digest pinning, signed provenance/artifacts                               | **NO-GO**                       |
| Android package   | Packaged release-manifest policy report, APK digest/signature/provenance, runtime analysis, and representative-device tests    | **NO-GO; STATIC EVIDENCE ONLY** |
| Media safety      | Authenticated upload, limits/type sniffing, scanning/transcoding, private immutable delivery, SSRF controls                    | **NO-GO**                       |
| Publishing        | Immutable revision/candidate/approval/release/assignment, idempotency, conflict/accessibility policy tests                     | **NO-GO**                       |
| Player identity   | Non-exportable key attestation/classification, server challenge proof, replay tests, rotation/revoke/reset evidence            | **NO-GO**                       |
| Playback recovery | Signature/hash/atomic activation/LKG, corrupt/full-disk/clock/network/reboot recovery on supported devices                     | **NO-GO**                       |
| Fleet operations  | Heartbeat/fallback/proof/ack accuracy, update rings, rollback, D-pad/accessibility tests                                       | **NO-GO**                       |
| Emergency         | Feature disabled, plus MFA/separate permission/two-person approval/expiry/partial delivery/recovery/tabletop before enablement | **NO-GO; MUST REMAIN DISABLED** |
| Recovery          | Encrypted off-host backup, checksum, isolated timed restore, object/DB consistency, deletion/revocation reconciliation         | **NO-GO**                       |
| Performance/SLO   | Representative load/capacity/failure tests, dashboards, alert drills, agreed SLO/RPO/RTO                                       | **NO-GO**                       |
| Governance        | Data flow, retention, privacy/terms/licenses/vendors/support, risk register and named approvals                                | **NO-GO**                       |

## Exceptions and residual risk

| Finding/risk | Severity | Scope | Compensating control | Owner | Due/review date | Approvers | Status   |
| ------------ | -------- | ----- | -------------------- | ----- | --------------- | --------- | -------- |
| TBD          | TBD      | TBD   | TBD                  | TBD   | TBD             | TBD       | **OPEN** |

An exception cannot waive tenant isolation, secret exposure, unauthorized publishing, emergency safeguards, or evidence integrity without explicit accountable security and product ownership. Every acceptance expires and must identify affected versions/environments.

## Human approvals

| Authority                   | Identity/signature | Date | Decision and conditions |
| --------------------------- | ------------------ | ---- | ----------------------- |
| Product owner               | Missing            | —    | **NO-GO**               |
| Security owner              | Missing            | —    | **NO-GO**               |
| Privacy/records/legal owner | Missing            | —    | **NO-GO**               |
| Operations/service owner    | Missing            | —    | **NO-GO**               |
| Pilot-site/business owner   | Missing            | —    | **NO-GO**               |

## Rollback and verification record

Previous immutable version/digests, schema compatibility, backup IDs/checksums, rollback commander, maintenance window, success probes, stop thresholds, and post-release observation owner are all TBD. Attach the completed record to the controlled release system; do not convert this repository template into mutable production evidence.
