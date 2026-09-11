# Agent-assisted hardening review — 2026-09-11

## Decision

This review improves the constrained prototype but does **not** approve ScreenGoblin for pre-production use. The only permitted evaluation remains a non-life-safety, non-PII lab pilot on an isolated signage VLAN with emergency publishing disabled. Physical Android hardware, PostgreSQL integration, Compose recovery, accessibility, browser E2E, and independent security evidence are still required.

## Review scope

Independent passes covered backend/application security, Console UX/accessibility, player/Android reliability, infrastructure/supply chain, and requirements/documentation. The review compared the implementation to the project handoff, Brand Package v1, root documentation, protocol, threat model, tests, deployment files, and current `main` branch.

## Resolved in this hardening change

- Authenticated requests revalidate the user, organization membership, and role. Disabled, removed, or downgraded users lose existing-token authority.
- Public screen DTOs exclude device verifier hashes.
- Manifest signing moved from unverifiable shared-secret HMAC to Ed25519. Players pin the public key at pairing, verify the signed envelope, and enforce screen binding before staging.
- Normal last-known-good content survives repeated emergency polls, clear, expiry, reboot recovery, and later playback rollback. Emergency manifest identity/duration is stable.
- Manifest validation bounds item/asset/release sizes, durations, future clock skew, URL schemes, checksums, and duplicates.
- Media metadata rejects non-HTTPS origins except loopback development, with a deployment allowlist for approved origins. Web frames no longer receive same-origin privileges.
- The live Console never silently substitutes demo data after an authenticated request fails. Fleet uses the API, errors are explicit, unsupported commands are disabled, basic role-aware controls are enforced, passwords are cleared, long text wraps, and brand tokens are consumed.
- Pairing codes use a deployment HMAC pepper at rest. Production config rejects HTTP API origins and reused JWT/pairing secrets.
- Automatic demo seeding was removed. Bootstrap is explicit, one-time, placeholder-resistant, and will not reset an owner password or grant unexpected privilege.
- API responses are non-cacheable, request bodies are capped at 2 MiB, proxy trust is restricted, Caddy admin is disabled, player/main-host headers are aligned, Android boot receiver exposure is reduced, and production source maps are disabled.
- Pairing creation and media/playlist/schedule lifecycle events now produce audit records.
- Schedule conflicts now have deterministic priority/start/ID ordering; expired media is excluded and release identity includes schedule timing.
- Vitest was upgraded to the advisory-fixed major release; the complete npm audit reports zero known vulnerabilities.
- Reproducible validation, changelog, contributor/agent invariants, AI boundaries, and corrected current-state protocol documentation were added.

## Remaining blocking work

1. Native Android Keystore device keypair/proof-of-possession or mTLS, credential rotation/revocation/re-enrollment/decommission, and verified local erasure.
2. Durable Redis-backed distributed pairing/login/device rate limits, per-code attempt budgets, collision handling, and abuse alerts.
3. First-class location/group/screen permission scopes and separate publish, device-control, audit, and emergency capabilities.
4. Immutable asset/content/playlist/manifest releases with draft, review, independent approval, publish, target snapshot, rollback parent, and optimistic concurrency.
5. Server-owned upload, type detection, malware scanning/transcoding, private media delivery, signed URL expiry, and tenant/object-storage isolation.
6. Emergency step-up MFA, independent approval, idempotent signed activation/clear, per-device received/verified/rendered/restored acknowledgements, partial-delivery escalation, and tabletop/physical-device evidence.
7. Durable two-slot native content cache with decode probes, storage reservation/GC, crash/power-loss tests, bundled neutral fallback, proof of play, screenshots, watchdog, commands, and update rings.
8. PostgreSQL-backed tenant/integrity/concurrency tests, browser E2E/accessibility/visual tests, Android emulator tests, supported physical-device matrix, load/soak/offline-window evidence, and measurable release thresholds.
9. Immutable image/APK release artifacts, digest pinning, image-layer scans, SBOM/provenance/signing, protected release environment, migration compatibility, executable rollback, and complete encrypted database/object restore drills with measured RPO/RTO.
10. Data-flow inventory, screenshot/log retention, no-student-PII profile, privacy/content policy, subprocessor and counsel review, incident ownership, SLOs/alerts, and go/no-go evidence records.

These are real release gates, not documentation cleanup. No checkmark in `docs/PREPRODUCTION.md` should be changed until reproducible evidence exists.
