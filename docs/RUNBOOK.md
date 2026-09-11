# Pre-production operations runbook

## Pilot guardrail

Operate the prototype only with non-life-safety, non-PII content on a dedicated signage VLAN. Keep `EMERGENCY_FEATURE_ENABLED=false`. Do not use ScreenGoblin as an emergency-notification system until the checklist gates, two-person approval, fail-safe behavior, and an operational tabletop exercise are complete.

The signage VLAN should deny client-to-client traffic, management-plane access, and access to RFC1918/link-local destinations except explicitly required DNS, NTP, DHCP, API/media endpoints, and approved device-management services. Admin access belongs on a separate trusted network.

## Deploy

1. Review the release notes, database migrations, and rollback compatibility.
2. Back up PostgreSQL and object storage; record the backup IDs.
3. Build immutable images from the reviewed commit and run CI/security gates.
4. Deploy to a staging host and run smoke tests with an offline player.
5. During the maintenance window, run `docker compose --env-file deploy/.env pull` for referenced images and `docker compose --env-file deploy/.env build --pull` for application images.
6. Run `docker compose --env-file deploy/.env up -d` and inspect `docker compose --env-file deploy/.env ps`.
7. Verify readiness, login, publish, pairing, manifest download, media checksum, heartbeat, and last-known-good playback.

Do not seed a reusable administrator password. Rotate or remove bootstrap credentials after the first successful login.

## Observe

Monitor API readiness and latency, HTTP 5xx/429 rates, failed logins, pairing failures, database/storage capacity, backup freshness, manifest build failures, offline/fallback screen counts, stale heartbeats, and command acknowledgement latency. Route emergency activation and authorization anomalies to a staffed channel.

Container logs:

```bash
docker compose --env-file deploy/.env logs --since=30m api caddy
docker compose --env-file deploy/.env ps
```

Logs must carry a request ID and must not contain passwords, JWTs, device tokens, signed URLs, or full sensitive payloads.

## Back up and restore

Back up to encrypted off-host storage. Keep database and object-store backups from a consistent release window. Redis is not authoritative.

Database backup example:

```bash
docker compose --env-file deploy/.env exec -T postgres \
  pg_dump --format=custom --no-owner --username "$POSTGRES_USER" "$POSTGRES_DB" > screengoblin.dump
```

The shell environment running that example must contain the same variables as `deploy/.env`. Never place backups in the web root. Test restoration into an isolated environment at least quarterly and verify a sample manifest can be reconstructed with its media.

## Roll back

Application rollback is safe only when the old application supports the migrated schema. Prefer forward-compatible, expand/migrate/contract database changes. Redeploy the prior image tag, verify readiness, and document the incident. Do not automatically reverse a destructive migration; restore the verified backup when required.

Players retain a last-known-good manifest and should be released in rings: development, lab, pilot site, then broad fleet. Stop rollout when crash rate, fallback state, or heartbeat loss exceeds the agreed threshold.

## Incident priorities

- **P1:** unauthorized/emergency content, suspected credential compromise, or district-wide outage. Revoke affected credentials, clear malicious overrides, preserve evidence, notify the incident lead, and use the out-of-band communication plan.
- **P2:** building-wide outage or publishing failure. Preserve cached playback, isolate the failing release, and roll back if schema-compatible.
- **P3:** individual player or noncritical feature. Capture diagnostics, keep fallback content active, and schedule repair.

After containment, rotate exposed secrets, retain audit/log evidence, identify affected tenants/screens, restore trusted content, and write a blameless review with corrective owners and dates.

## Routine maintenance

- Weekly: review offline screens, failed jobs, capacity, certificate expiry, and security alerts.
- Monthly: patch staging, promote through release rings, restore a small backup sample, and review privileged users.
- Quarterly: full restore drill, device credential rotation sample, incident exercise, and access review.
