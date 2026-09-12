# Pre-production operations runbook

## Pilot guardrail

Operate the prototype only with non-life-safety, non-PII content on a dedicated signage VLAN. Keep `EMERGENCY_FEATURE_ENABLED=false`. Do not use ScreenGoblin as an emergency-notification system until the checklist gates, two-person approval, fail-safe behavior, and an operational tabletop exercise are complete.

The signage VLAN should deny client-to-client traffic, management-plane access, and access to RFC1918/link-local destinations except explicitly required DNS, NTP, DHCP, API/media endpoints, and approved device-management services. Admin access belongs on a separate trusted network.

## Deploy

1. Review the release notes, database migrations, and rollback compatibility. Confirm production has `DEVICE_AUTH_MODE=proof-v1`; the API must refuse `development-bearer` in production.
2. Back up PostgreSQL and object storage; record the backup IDs.
3. Build immutable images from the reviewed commit and run CI/security gates.
4. Deploy to a staging host and run smoke tests with an offline player.
5. During the maintenance window, run `docker compose --env-file deploy/.env pull` for referenced images and `docker compose --env-file deploy/.env build --pull` for application images.
6. Run `docker compose --env-file deploy/.env up -d` and inspect `docker compose --env-file deploy/.env ps`.
7. On a new installation only, run `docker compose --env-file deploy/.env --profile bootstrap run --rm api-seed`. Confirm the owner can sign in, then remove all `SEED_*` values from the host environment.
8. Verify readiness, login, two-stage Android Keystore pairing, proof-authorized heartbeat and manifest delivery, atomic pairing/audit, Ed25519 manifest verification, media checksum, signed withdrawal, schedule-boundary blanking, last-known-good playback, and OWNER/ADMIN credential revocation. Confirm replayed proofs fail. Do not claim that a revoked online player erased managed media until verified native erasure is implemented and evidenced.

Tenant-integrity and normalized-email migrations deliberately abort if they find cross-organization relationships or case-colliding accounts. Before applying them, stop writers, take a verified backup, run the documented preflight queries in a restored staging copy, and investigate every conflict; do not bypass the checks or relabel records automatically.

Do not run the bootstrap profile as part of normal startup. It refuses to reset an existing owner password or grant owner to an existing unrelated user. Remove bootstrap credentials after the first successful login.

## Observe

Monitor API readiness and latency, HTTP 5xx/429 rates, failed logins, pairing failures, database/storage capacity, backup freshness, manifest build failures, offline/fallback screen counts, stale heartbeats, and command acknowledgement latency. Route emergency activation and authorization anomalies to a staffed channel.

Container logs:

```bash
docker compose --env-file deploy/.env logs --since=30m api caddy
docker compose --env-file deploy/.env ps
```

Logs must carry a request ID and must not contain passwords, JWTs, bearer device tokens, pairing codes, device proof challenges/signatures, public-key enrollment payloads, signed URLs, or full sensitive payloads.

## Back up and restore

Back up to encrypted off-host storage. Keep database and object-store backups from a consistent release window. Redis is not authoritative.

Create a checksum-bound PostgreSQL custom-format dump without overwriting an existing backup:

```bash
SCREENGOBLIN_ENV_FILE=deploy/.env \
POSTGRES_BACKUP_DIR=/path/to/encrypted/off-host/staging \
deploy/scripts/postgres-backup.sh
```

The script writes a restrictive-permission dump and adjacent `.sha256`, refuses collisions, and verifies the checksum. Never place backups in the web root. Move both files to encrypted off-host storage using an independently monitored job.

Restore into the safe default `screengoblin_restore_validation` database:

```bash
SCREENGOBLIN_ENV_FILE=deploy/.env \
deploy/scripts/postgres-restore.sh /path/to/screengoblin-TIMESTAMP.dump
```

The restore requires the adjacent checksum and refuses to replace any existing database by default. Restoring into a protected database requires the explicit `ALLOW_DANGEROUS_RESTORE=I_UNDERSTAND_THIS_CAN_DESTROY_DATA` acknowledgement; replacing an existing database separately requires `ALLOW_EXISTING_RESTORE_DATABASE=I_UNDERSTAND_THIS_OVERWRITES_A_DATABASE`. Take a fresh backup, stop writers, and obtain the operational approval required by local policy before either override. Do not use an override for routine validation.

Object storage needs a matching versioned backup and integrity inventory; the PostgreSQL scripts do not back up MinIO. Test restoration into an isolated environment at least quarterly and verify a sample manifest can be reconstructed with its media. `.github/workflows/recovery-drill.yml` exercises disposable PostgreSQL dump/restore, MinIO object delete/restore/byte comparison, and retained-image rollback monthly and when its implementation changes. It pulls exact fixture tags once, records their resolved repository digests, and uses those immutable digests with `--pull never` during the drill. Runtime fixture resolution is test evidence, not production provenance. Passing CI is development evidence, not proof that off-site production backups, credentials, RPO, or RTO work.

## Roll back

Application rollback is safe only when the old application supports the migrated schema. Prefer forward-compatible, expand/migrate/contract database changes. Redeploy the prior image tag, verify readiness, and document the incident. Do not automatically reverse a destructive migration; restore the verified backup when required.

Players retain a last-known-good manifest and prune the Android app-private
native cache, or browser development CacheStorage, to assets referenced by the
active and rollback generations. Signed withdrawals and `playbackEndsAt`
boundaries intentionally blank expired schedules; an ordinary manifest lease
expiry does not erase offline last-known-good playback. Monitor native available
storage, download verification failures, staging cleanup failures, prune
failures, fallback state, and device free storage. Repeated hash/size mismatches
should stop the release and trigger origin/object integrity investigation;
repeated write/rename failures should stop the affected device ring and trigger
storage and filesystem diagnosis. Never clear a cache merely to hide pressure
before preserving diagnostics.

Players should be released in rings: development, lab, pilot site, then broad
fleet. Stop rollout when crash rate, fallback state, storage pressure, native
cache errors, or heartbeat loss exceeds the agreed threshold. Before fleet use,
capture representative physical-device evidence for low-space/full-disk
behavior, process death and power loss during streaming and atomic publication,
reboot recovery, completed-orphan pruning, abandoned-staging cleanup, and
telemetry accuracy. Host tests and a successful APK build do not close these
gates.

The release-evidence workflow retains checksum-bound local Docker archives for tags/manual runs, but those artifacts are explicitly unsigned and are not production releases. A production rollback must use an approved, signed, immutable registry digest whose schema compatibility and retention have been verified. See `docs/RELEASE_EVIDENCE.md`.

## Incident priorities

- **P1:** unauthorized/emergency content, suspected device-key/credential compromise, or district-wide outage. Revoke affected credentials, isolate affected players at the network/device-management layer, recover offline units physically when recall is required, clear malicious overrides, preserve evidence, notify the incident lead, and use the out-of-band communication plan. Server revocation alone cannot erase cached media from a disconnected player.
- **P2:** building-wide outage or publishing failure. Preserve cached playback, isolate the failing release, and roll back if schema-compatible.
- **P3:** individual player or noncritical feature. Capture diagnostics, keep fallback content active, and schedule repair.

After containment, rotate exposed secrets, retain audit/log evidence, identify affected tenants/screens, restore trusted content, and write a blameless review with corrective owners and dates.

## Routine maintenance

- Weekly: review offline screens, failed jobs, capacity, certificate expiry, and security alerts.
- Monthly: patch staging, promote through release rings, restore a small backup sample, and review privileged users.
- Quarterly: full restore drill, lab device revoke/re-enrollment exercise,
  incident exercise, and access review. The re-enrollment exercise must record
  the target screen, required operational reason, and starting generation;
  immediate old-key revocation and the resulting offline state;
  explicit local Player key reset; exact candidate fingerprint comparison on the
  physical display and Console; separate OWNER/ADMIN activation; preservation of
  screen assignments; denial of the old key; and cancellation of stale grants.
  Treat expiry or a fingerprint mismatch as a stop condition and cancel the
  grant. Do not activate an unverified candidate.

  This manual zero-overlap recovery flow causes intentional downtime and is not
  automatic credential rotation. Hardware/application attestation, old/new key
  overlap, verified Keystore/media erasure, offline recall, and representative
  physical-device evidence remain tracked release gates.
