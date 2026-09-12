# Pre-production readiness checklist

An unchecked item is a known gap, not an implicit approval.

## Pilot boundary (mandatory)

- [ ] Pilot content is non-life-safety and contains no student, staff, visitor, or other PII.
- [ ] Players run on a dedicated signage VLAN with client isolation and only required outbound access.
- [x] Production startup rejects `EMERGENCY_FEATURE_ENABLED=true`; this
      containment control remains required until every emergency/security gate
      is implemented and signed off. This does not complete those gates or
      authorize emergency use.
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
- [ ] Pairing is single-use, short-lived, rate-limited, transcript/key-bound, proof-verified, and audited on representative managed Android hardware.
- [ ] Device revocation, targeted re-enrollment, credential/key rotation, offline recovery, and verified local media/state erasure pass operational and physical-device tests.
- [ ] Android hardware/application attestation policy is implemented, or its absence has a named risk owner, compensating controls, and an approved review date.
- [ ] Upload scanning, type validation, limits, and safe transcoding are enabled.
- [ ] Secrets are in a managed secret store and rotation is rehearsed.
- [ ] Images are digest-pinned; release artifacts have SBOMs and signatures.
- [ ] Dependency, CodeQL, container, DAST, and secret scans are clean or exceptions accepted.
      CI now blocks repository secrets, IaC/configuration misconfigurations, and
      unapproved lockfile licenses with narrow expiring exceptions and retained
      checksum-bound static evidence. This is not DAST or production-runtime
      coverage, so the combined gate remains unchecked.
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

- [ ] Terms, privacy notice, retention policy, license inventory, and support ownership are approved.
- [ ] Protected branch requires review and passing CI/security checks.
- [ ] Release version, immutable image digest, APK signature, and change log are recorded.
- [ ] Emergency workflow has designated roles, two-person approval, and a tabletop exercise.
- [ ] Product owner, security owner, and operations owner sign the go/no-go record.
