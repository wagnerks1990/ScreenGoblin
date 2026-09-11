# ScreenGoblin API

Fastify/TypeScript control-plane API for the ScreenGoblin pre-production prototype. PostgreSQL is accessed through Prisma. Device playback is outbound-only: players pair once, authenticate with unique random credentials, send heartbeats, and fetch signed manifests.

## Run locally

Requires Node 22+ and PostgreSQL 16+.

```bash
cp apps/api/.env.example apps/api/.env
npm install
npm run prisma:generate -w @screengoblin/api
npm run prisma:migrate:dev -w @screengoblin/api -- --name initial
npm run prisma:seed -w @screengoblin/api
npm run dev -w @screengoblin/api
```

The API listens on port `3000` by default. Replace both secrets and the seeded password before exposing the service. `/health/live` verifies the process; `/health/ready` also checks PostgreSQL.

## API surface

All management endpoints use `Authorization: Bearer <JWT>` and are scoped to the token's organization.

- `POST /api/v1/auth/login`, `GET /api/v1/auth/me`
- `GET|POST|PATCH|DELETE /api/v1/screens`
- `GET|POST|DELETE /api/v1/media`
- `GET|POST|DELETE /api/v1/playlists`
- `GET|POST|DELETE /api/v1/schedules`
- `POST /api/v1/emergencies`, `POST /api/v1/emergencies/:id/clear`
- `GET /api/v1/audit-events`
- `POST /api/v1/pairing-codes`

Player endpoints use `X-Screen-Id` and `X-Device-Token` after the initial pairing call:

- `POST /api/v1/device/pair`
- `POST /api/v1/device/heartbeat`
- `GET /api/v1/device/manifest`

The manifest contains SHA-256 asset checksums and an HMAC-SHA256 signature. Players must download and verify every asset before atomically activating a manifest, retaining the previous complete manifest as last-known-good content.

## Security and scope

- OWNER/ADMIN control screens and emergency takeovers; PUBLISHER may manage ordinary content and schedules; VIEWER is read-only.
- Emergency publishing is supplemental—not a life-safety or mass-notification system—and is disabled by default. Set `EMERGENCY_FEATURE_ENABLED=true` only after local policy, authorization, failover, and end-to-end device acknowledgment have been validated.
- Database queries include organization scope. Device tokens and pairing codes are SHA-256 hashed at rest; their source values have sufficient entropy or short expiry.
- Security headers, strict CORS, payload limits, endpoint/global rate limits, generic server errors, structured validation failures, and secret-redacted logs are enabled.
- Media upload/transcoding and object-storage presigning are intentionally adapter boundaries. This prototype stores validated metadata only.

## Validation

```bash
npm run typecheck -w @screengoblin/api
npm test -w @screengoblin/api
npm run build -w @screengoblin/api
```

Tests use the in-memory store and Fastify injection; they do not require a live database. Apply migrations and run a PostgreSQL-backed smoke test before deployment.
