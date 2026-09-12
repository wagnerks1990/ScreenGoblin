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
- Production request protection now requires Redis and applies distributed,
  fail-closed login, pairing, heartbeat, and manifest budgets without placing
  raw account, code, device, or source identifiers in backend keys.
- The Android wrapper creates a non-exportable P-256 Keystore identity key and
  exposes a constrained, domain-separated signing operation. Server enrollment
  and proof verification remain intentionally disabled.
- Keyboard form submission, dialog focus management, operational status
  announcements, and complete session clearing on unauthorized mutations have
  automated regressions.
- Image scanning, SBOM/release evidence, guarded PostgreSQL backup/restore, and
  disposable database/object/image recovery workflows are implemented for CI
  evidence; artifact signing and real-environment recovery evidence remain open.
- Governance, privacy, incident, SLO, supported-device, authorization, and
  immutable-release documents now exist as explicit unapproved NO-GO plans.
- Reproducible validation, changelog, contributor/agent invariants, AI boundaries, and corrected current-state protocol documentation were added.
- Pairing allocation now handles live-code collisions and expired-code reuse;
  both issuance and claim audit writes are transactional with their mutations.
- Manifest polling uses stable semantic versions, signed withdrawals, and signed
  schedule playback boundaries. Player synchronization and rollback are
  serialized/version-conditional, and asset staging has bounded memory,
  concurrency, deadlines, integrity checks, and generation pruning.
- CI now exercises PrismaStore against migrated PostgreSQL for tenant-scoped
  access, pairing races and rollback, uniqueness, BIGINT safety, and
  deterministic multi-organization identity behavior.
- Composite database constraints now bind playlist assets, schedules, targets,
  and paired screens to one organization; migration preflights refuse dirty
  cross-tenant rows. Case-insensitive email identity is unique and ambiguous
  legacy authentication fails closed.
- Production media origins are explicit and fail closed, legacy records are
  filtered during manifest generation, and binary redirects are rejected.
  Direct DNS rebinding/egress and sandboxed web navigation remain deployment
  gates.
- Schedule activation and signed playback boundaries now cover DST gaps,
  repeated hours, fractional offsets, and next-day midnight deterministically.

## Remaining blocking work

1. Server enrollment and replay-safe verification of the Android Keystore key, credential rotation/revocation/re-enrollment/decommission, and verified local erasure.
2. Pairing abuse alert delivery/telemetry and production threshold calibration for the distributed request budgets.
3. First-class location/group/screen permission scopes and separate publish, device-control, audit, and emergency capabilities.
4. Immutable asset/content/playlist/manifest releases with draft, review, independent approval, publish, target snapshot, rollback parent, and optimistic concurrency.
5. Server-owned upload, type detection, malware scanning/transcoding, private media delivery, signed URL expiry, and tenant/object-storage isolation.
6. Emergency step-up MFA, independent approval, idempotent signed activation/clear, per-device received/verified/rendered/restored acknowledgements, partial-delivery escalation, and tabletop/physical-device evidence.
7. Durable native stream-to-disk content cache with decode probes, quota/free-space telemetry, crash/power-loss tests, bundled neutral fallback, proof of play, screenshots, watchdog, commands, and update rings. The web cache now bounds verification memory and retains active/rollback generations but is not physical-device evidence.
8. Broader PostgreSQL integrity/concurrency and migration-upgrade coverage, browser E2E/accessibility/visual tests, Android emulator tests, supported physical-device matrix, load/soak/offline-window evidence, and measurable release thresholds.
9. Registry promotion, immutable image/APK artifacts, digest pinning, provenance/signing, protected release environments, migration compatibility, off-host encrypted restoration, and measured RPO/RTO. CI image scans, SBOM generation, and disposable rollback drills are implemented but are not production evidence.
10. Approval of the draft data-flow, retention, no-student-PII, incident, SLO, supported-device, and go/no-go records, plus privacy/content policy, subprocessor review, counsel review, and named operational ownership.

These are real release gates, not documentation cleanup. No checkmark in `docs/PREPRODUCTION.md` should be changed until reproducible evidence exists.
