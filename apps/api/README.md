# ScreenGoblin API

Fastify/TypeScript control-plane API for the ScreenGoblin pre-production prototype. PostgreSQL is accessed through Prisma. Device playback is outbound-only: production Android players enroll a unique Keystore P-256 public key, prove possession for each heartbeat and manifest request, and verify signed manifests.

## Run locally

Requires Node 22+, PostgreSQL 17+, and Redis 7+.

```bash
cp apps/api/.env.example apps/api/.env
npm install
npm run prisma:generate -w @screengoblin/api
npm run prisma:migrate:dev -w @screengoblin/api -- --name initial
npm run prisma:seed -w @screengoblin/api
npm run dev -w @screengoblin/api
```

The API listens on port `3000` by default. Generate independent JWT and pairing secrets, a random manifest-signing seed, and a unique seeded password before exposing the service. Production startup rejects documented placeholders, checked-in test secrets, and the all-zero signing seed used by automated tests. `/health/live` returns an empty `204` when the process is alive. The internal-only `/health/ready` returns an empty `204` only when PostgreSQL and the production Redis request-protection backend are reachable; failures return an empty `503` without identifying the failed dependency.

`PUBLIC_API_URL` is the external control-plane origin returned during device
pairing. Production accepts only a credential-free HTTPS origin with no path,
query, or fragment, and normalizes its host/default port before constructing
`/api/v1/device`. Invalid values stop startup before a pairing code can be
consumed into an unusable Player configuration.

## API surface

All management endpoints use `Authorization: Bearer <JWT>` and are scoped to the token's organization.

- `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, `POST /api/v1/auth/logout`
- `GET|POST|PATCH|DELETE /api/v1/screens`
- `GET|POST|PATCH|DELETE /api/v1/locations`
- `GET|DELETE /api/v1/media` (`POST` is deprecated and disabled by default;
  production rejects enabling it)
- `GET|POST|DELETE /api/v1/playlists`
- `GET|POST|DELETE /api/v1/schedules`
- `POST /api/v1/emergencies`, `POST /api/v1/emergencies/:id/clear`
- `GET /api/v1/audit-events`
- `POST /api/v1/pairing-codes`
- `POST /api/v1/screens/:id/device-credential/revoke`
- `POST /api/v1/screens/:id/device-reenrollment` (required operational reason)
- `GET|DELETE /api/v1/screens/:id/device-reenrollment/:grantId`
- `POST /api/v1/screens/:id/device-reenrollment/:grantId/candidates/:candidateId/activate`

Production Player endpoints use the two-stage `proof-v1` protocol:

- `POST /api/v1/device/pair/challenge`
- `POST /api/v1/device/pair`
- `POST /api/v1/device/challenges`
- `POST /api/v1/device/heartbeat`
- `GET /api/v1/device/manifest`

Pairing and request proofs use the Android Keystore P-256 identity, short-lived one-use challenges, strict domain-separated `ES256-DER` signatures, and operation/body-digest binding. See [`docs/DEVICE_PROTOCOL.md`](../../docs/DEVICE_PROTOCOL.md) for the exact contract. Production requires `DEVICE_AUTH_MODE=proof-v1`. `X-Device-Token` is retained only for explicit non-production localhost browser development in `development-bearer` mode.

The manifest contains SHA-256 asset checksums and an Ed25519 signature. Pairing pins the deployment public key; players verify the signed envelope and expected screen ID before downloading assets and atomically activating a manifest. Emergency overlays never replace the normal last-known-good rollback baseline.

Ordinary media capabilities expire at the earliest manifest lease, frozen
schedule boundary, or frozen asset expiry. Each capability binds the immutable
assignment ID and digest; delivery rechecks the current credential and that the
assignment is still the latest active assignment for that tenant, screen, and
asset. Withdrawal therefore denies subsequent online reads immediately. A
player that already downloaded verified bytes remains governed by the signed
local playback boundaries and offline-recall limitations.

The withdrawal guarantee applies to reads authorized after the database commit.
A stream that completed its authorization recheck before the commit may finish;
stopping such an in-flight object response would require coordinated stream
revocation across PostgreSQL and object storage.

## Security and scope

- Locations are stable, tenant-bound administrative classifications. Existing
  screen location labels remain compatible, and assigning a classification is
  optional. This foundation does not add user grants, filter resources, or
  change effective organization-role authorization; locations must not yet be
  treated as authorization scopes.

- OWNER/ADMIN control screens; PUBLISHER may manage ordinary content and
  schedules; VIEWER is read-only. Legacy emergency routes exist only for
  isolated non-production fixtures. Their activation and clear writes recheck
  current capabilities, lock organization-scoped targets, and commit audit and
  state atomically, but they are not a complete approval or authorization model.
- `POST /schedules` requires a canonical UUIDv4 `Idempotency-Key`. Its raw
  value is neither logged nor stored. The transaction revalidates the active
  membership, tenant-binds the key fingerprint, and commits the publication,
  audit, and replay response together. Same-command retries cannot reactivate a
  withdrawn assignment; a new key is required for intentional republication.
- Emergency publishing is supplemental—not a life-safety or mass-notification
  system—and production startup rejects `EMERGENCY_FEATURE_ENABLED=true` while
  the required authorization, two-person approval, MFA, acknowledgement,
  partial-delivery, recovery, and tabletop gates remain incomplete. The flag is
  available only outside production for isolated automated fixtures.
- Database queries include organization scope. Public screen responses exclude bearer verifier hashes and private device-authentication state. Pairing codes use a deployment-specific HMAC pepper at rest. Proof challenges are short-lived, stored only as hashes, durably bounded, and consumed once after valid signature verification. OWNER/ADMIN revocation transactionally disables a credential, invalidates outstanding challenges, marks the screen, and appends one audit record.
- Proof-v1 supports manual, targeted, zero-overlap re-enrollment of an
  existing screen. The request immediately revokes the old identity; fresh-key
  proof stages a candidate; and a separate OWNER/ADMIN exact-fingerprint
  activation is required. It does not provide server-verified
  hardware/application attestation, automatic overlapping key rotation, offline
  recall, verified native erasure, or physical-device identity; those remain
  pilot/release gates.
- Staff email login is case-insensitive. PostgreSQL enforces a functional unique index on `LOWER(email)`; its migration aborts without changing data when legacy case-only duplicates exist, and runtime lookup also fails closed if it encounters ambiguous identity data.
- User access tokens expire after one hour and contain a random per-login session
  identity. Only its SHA-256 hash is stored. Every authenticated request rechecks
  that exact session's expiry/revocation and immutable user-authentication and
  membership-authorization epoch snapshots against live identity state.
  `POST /auth/logout` revokes only the presented session and records the
  revocation atomically; the Console attempts it before clearing tab storage and
  reports when server revocation cannot be confirmed. Internal, system-audited
  store methods rotate password hashes, disable users, change roles, or remove
  memberships while advancing the applicable epoch and revoking affected
  sessions in the same transaction. There are no public password, user-disable,
  role, or membership mutation endpoints in this prototype.
- Failed login attempts for known and unknown accounts produce the same generic
  credential response and one tenant-neutral security event. Events contain
  only deployment-secret, domain-separated HMAC account/source keys, a bounded
  reason, and server time; raw email, password, and source IP are never stored.
  Event persistence is deliberately fail-safe: if the authoritative store
  cannot record an invalid-credential or rate-limit rejection, login returns
  the same generic `503 AUTH_TELEMETRY_UNAVAILABLE` for known and unknown
  accounts instead of silently losing telemetry. Inserts prune events older
  than 30 days and cap the table at 10,000 newest rows. Pruning is
  insertion-triggered, so a dormant deployment may retain aged rows until the
  next failed or rate-limited login.
- Login resolves identity eligibility and the stable first-organization
  compatibility membership with one fixed SQL statement. Known, unknown,
  disabled, and membershipless attempts then perform exactly one bcrypt
  comparison; ineligible identities use a supported fixed cost-12 dummy hash.
  This reduces account-existence timing distinguishability but does not make
  authentication constant time or disclose whether a tenant membership exists.
- Security headers, strict CORS, payload limits, endpoint/global rate limits, generic server errors, structured validation failures, and secret-redacted logs are enabled. Production rate limits use Redis and fail closed; login, pairing creation/claim, heartbeat, and manifest budgets use HMAC-derived keys so Redis never receives raw account, code, device, or source identifiers.
- Private object delivery is implemented, but upload, quarantine, scanning, safe
  decoding, and transcoding are not. The legacy caller-supplied metadata route
  is deprecated, disabled by default, and forbidden in production. The required
  durable state machine and external controls are specified in
  [`docs/MEDIA_INGESTION_DESIGN.md`](../../docs/MEDIA_INGESTION_DESIGN.md).

## Validation

```bash
npm run typecheck -w @screengoblin/api
npm test -w @screengoblin/api
npm run build -w @screengoblin/api
```

Tests use the in-memory store and Fastify injection; they do not require a live database. Apply migrations and run a PostgreSQL-backed smoke test before deployment.
