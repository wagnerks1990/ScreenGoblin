# Pre-production readiness checklist

An unchecked item is a known gap, not an implicit approval.

## Pilot boundary (mandatory)

- [ ] Pilot content is non-life-safety and contains no student, staff, visitor, or other PII.
- [ ] Players run on a dedicated signage VLAN with client isolation and only required outbound access.
- [x] Production startup rejects `EMERGENCY_FEATURE_ENABLED=true`; this
      containment control remains required until every emergency/security gate
      is implemented and signed off. This does not complete those gates or
      authorize emergency use. Legacy role bundles also grant neither emergency
      activation nor clear authority, including when the non-production flag is
      forced on.
- [ ] The pilot owner understands ScreenGoblin is not the authoritative emergency-notification system.

## Product and reliability

- [ ] Core console flows have automated browser tests.
- [ ] Scheduling conflict and daylight-saving boundaries have tests.
- [ ] Player survives network loss, reboot, corrupt downloads, full disk, and clock drift.
- [ ] Manifest update is checksum-verified, signed, atomic, and retains last-known-good content.
- [ ] Emergency override expires and normal playback resumes without operator repair.
- [ ] Proof-of-play and heartbeat status are independently verified on target hardware.
- [ ] Accessibility and D-pad-only Android TV navigation are tested.

## Security and privacy

- [ ] Organization isolation has positive and negative API tests.
- [ ] Production SSO/MFA and least-privilege roles are enabled.
      Tenant-bound grant/group tables and a pure deny-by-default evaluator are
      present, and exact-membership organization-wide compatibility grants are
      backfilled without session or epoch changes, but a database latch keeps
      policy in legacy mode. Candidate creation has a non-authoritative bounded
      comparison canary; remaining shadow evidence, scoped read/mutation enforcement, administration,
      SSO/MFA, and human access review remain incomplete.
      Deployment-seeded owner credentials are now time-bound to 24 hours and
      restricted to one-time password rotation; that rotation revokes sessions
      and pending issuer authority across memberships. This containment does
      not provide SSO, MFA, breached-password screening, secret-store delivery,
      or an approved human recovery process, so the gate remains unchecked.
- [ ] Pairing is single-use, short-lived, rate-limited, transcript/key-bound, proof-verified, and audited on representative managed Android hardware.
- [ ] Device revocation, targeted re-enrollment, credential/key rotation, offline recovery, and verified local media/state erasure pass operational and physical-device tests.
- [ ] Android hardware/application attestation policy is implemented, or its absence has a named risk owner, compensating controls, and an approved review date.
- [ ] Upload scanning, type validation, limits, and safe transcoding are enabled.
      The deprecated metadata-registration route and configuration switch are
      removed, and no upload/multipart/remote-fetch route exists; this containment
      does not implement or complete the ingestion gate.
- [ ] Secrets are in a managed secret store and rotation is rehearsed.
- [ ] Images are digest-pinned; release artifacts have SBOMs and signatures.
- [ ] Dependency, CodeQL, container, DAST, and secret scans are clean or exceptions accepted.
      CI now blocks repository secrets, IaC/configuration misconfigurations, and
      unapproved lockfile licenses with narrow expiring exceptions and retained
      checksum-bound static evidence. CI also performs blocking unauthenticated
      active scans and explicit method, CORS, error-leakage, and reflection
      probes against the disposable production-mode Caddy surfaces, including
      host-specific CSP checks that reject wildcard, scheme-wide, and inline
      style sources. Low/Medium/High alerts block independently of the scanner
      wrapper; all Informational alerts remain retained and separately counted
      without rule-ID suppression. Wrapper finding exits 1/2 defer only to a
      valid complete report and coverage summary; operational exits, timeouts,
      signals, and malformed evidence block. Fastify route/inventory drift and incomplete ZAP seed
      coverage fail closed, and scanner state has a 256 MiB tmpfs limit. This does not cover authenticated routes,
      capability-authorized private media, production TLS/network
      configuration, or manual review, so the combined gate remains unchecked.
- [ ] Screenshot collection/retention has privacy approval.
- [ ] Independent penetration test findings are closed or accepted.

## Operations

- [ ] Dashboards and actionable alerts cover API, database, storage, and player fleet.
- [ ] Encrypted off-host backups meet documented RPO/RTO.
- [ ] A full restore has succeeded in an isolated environment.
- [ ] Schema migrations are forward-compatible and rollback is rehearsed.
- [ ] Runbooks, escalation contacts, maintenance windows, and status communication are approved.
- [ ] DNS, TLS, firewall, time synchronization, and capacity/load tests pass.
- [ ] Pilot release on representative Android/Google TV and managed signage hardware succeeds.

## Governance and release

- [ ] The ordinary release-candidate workflow is operationally accepted and its
      Console UX, scoped grants, MFA/re-authentication, retention monitoring, and
      human evidence have been validated. The API now blocks direct publication
      and enforces distinct author/approver identities, but that engineering
      control alone does not complete this gate.
- [ ] Terms, privacy notice, retention policy, license inventory, and support ownership are approved.
- [ ] Protected branch requires review and passing CI/security checks.
- [ ] Release version, immutable image digest, APK signature, and change log are recorded.
- [ ] Emergency workflow has designated roles, two-person approval, and a tabletop exercise.
- [ ] Product owner, security owner, and operations owner sign the go/no-go record.
