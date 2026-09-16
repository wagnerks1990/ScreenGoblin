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
      An acknowledged offline, create-only command can provision `ADMIN`,
      `PUBLISHER`, or `VIEWER` accounts with one exact compatibility-grant
      bundle, tenant audit events, and a fixed 24-hour forced-rotation
      credential; non-exact existing emails fail closed, an exact rerun is
      verification-only, and `OWNER` is forbidden. This provides a bounded
      pilot path, not SSO/MFA, remote lifecycle
      administration, dual control, approved recipient verification, or human
      access-review evidence, so the gate remains unchecked.
      PostgreSQL deployment identities are separated: the schema owner is
      reserved for migrations/privilege reconciliation, while the API, seed,
      and offline recovery use a non-owning runtime role denied schema/trigger
      changes, truncation, migration-ledger access, protected-history rewrites,
      and root identity deletion. The runtime role still has broad cross-tenant
      CRUD on most application tables and there is no RLS. Managed-database
      equivalence, production secret custody/rotation, and administrator access
      review are also not evidenced, so this gate remains unchecked.
- [ ] Pairing is single-use, short-lived, rate-limited, transcript/key-bound, proof-verified, and audited on representative managed Android hardware.
- [ ] Device revocation, targeted re-enrollment, credential/key rotation, offline recovery, and verified local media/state erasure pass operational and physical-device tests.
- [ ] Android hardware/application attestation policy is implemented, or its absence has a named risk owner, compensating controls, and an approved review date.
- [ ] Upload scanning, type validation, limits, and safe transcoding are enabled.
      The deprecated metadata-registration route and configuration switch are
      removed, and no upload/multipart/remote-fetch route exists; this containment
      does not implement or complete the ingestion gate.
- [ ] Secrets are in a managed secret store and rotation is rehearsed.
- [ ] Images are digest-pinned; release artifacts have SBOMs and signatures.
      CI now inspects the manifest packaged inside the assembled Android release
      APK and rejects drift from the exact package, SDK, permission, optional
      feature, application-flag, launcher-activity, and boot-receiver policy. It
      permits only the package-scoped signature permission and non-exported
      AndroidX Startup provider required by the packaged dependencies, with
      exactly the lifecycle and emoji initializers; ProfileInstaller and DUMP
      surfaces are removed. It rejects other package visibility,
      instrumentation, libraries, aliases, services, providers, permissions,
      and initializers. The JSON report records the analyzer version plus APK
      and packaged-manifest SHA-256 values, but remains static package-surface
      evidence only; it is not an APK signature,
      provenance, an OWASP MASVS assessment, malware analysis, or
      physical-device evidence, so this gate remains unchecked.
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
      The restore helper verifies checksums, uses `--no-owner --no-acl`, reapplies
      runtime privileges, and blocks success unless runtime read/write access
      and owner-only denials validate. This repository behavior is not evidence
      of an approved full-environment restore with matching object storage.
- [ ] Schema migrations are forward-compatible and rollback is rehearsed.
- [ ] Runbooks, escalation contacts, maintenance windows, and status communication are approved.
- [ ] DNS, TLS, firewall, time synchronization, and capacity/load tests pass.
- [ ] Pilot release on representative Android/Google TV and managed signage hardware succeeds.

## Governance and release

- [ ] The ordinary release-candidate workflow is operationally accepted and its
      Console UX, scoped grants, MFA/re-authentication, retention monitoring, and
      human evidence have been validated. The API now blocks direct publication
      and enforces distinct author/approver identities. The repository browser
      gate provisions and rotates separate `PUBLISHER` and `ADMIN` users, proves
      the publisher cannot approve, and verifies create/submit, admin approval,
      publisher publication, assignment, schedule, and audit attribution. That
      engineering evidence does not replace operational acceptance, scoped
      grants, MFA/re-authentication, retention monitoring, or human review, so
      the gate remains unchecked.
- [ ] Terms, privacy notice, retention policy, license inventory, and support ownership are approved.
- [ ] Protected branch requires review and passing CI/security checks.
- [ ] Release version, immutable image digest, APK signature, and change log are recorded.
      A packaged-manifest policy report may be attached as supporting static
      evidence, but it does not replace the APK digest, production signing
      certificate fingerprint, provenance, or controlled release record.
- [ ] Emergency workflow has designated roles, two-person approval, and a tabletop exercise.
- [ ] Product owner, security owner, and operations owner sign the go/no-go record.
