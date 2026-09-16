# ScreenGoblin

ScreenGoblin is an Android-first digital-signage platform for schools and small organizations. It combines a browser-based operations console, a Fastify API, and an offline-capable player that can be packaged as an Android TV APK.

This repository is a **pre-production prototype**. It demonstrates the core control plane and player protocol; it is not yet approved for life-safety messaging or unattended production use. See [the pre-production checklist](docs/PREPRODUCTION.md).

The minimum permitted pilot is **non-life-safety, contains no PII, and runs on a dedicated signage VLAN**. Emergency activation stays disabled by default until the security, reliability, governance, and tabletop gates are complete.

## Products

- `apps/console` — content and fleet operations UI.
- `apps/api` — organization-scoped API, scheduling, pairing, manifests, and audit data.
- `apps/player` — web player and Android wrapper with last-known-good playback.
- `packages/contracts` — shared API and device-protocol types.

Architecture, operating, and security details are in [`docs/`](docs/README.md).

## Local development

Requirements: Node.js 22+, npm 10+, PostgreSQL 17+, and optionally Android Studio/JDK 21 for APK work.

```bash
npm ci
cp apps/api/.env.example apps/api/.env
npm run prisma:generate -w @screengoblin/api
npm run prisma:migrate:dev -w @screengoblin/api
npm run prisma:seed -w @screengoblin/api
npm run dev
```

The default development endpoints are console `http://localhost:5173`, player `http://localhost:5174`, and API `http://localhost:3000`. Values may differ if a port is already occupied.

Run the full validation gate before opening a pull request:

```bash
npm run validate
```

`validate` generates the Prisma client before formatting, linting, type checks,
tests, and production builds, so it works from a clean `npm ci` checkout.

## Container deployment

The supplied Compose stack is intended for one pre-production host. It runs Caddy, the console, a browser-hosted player build, the API, PostgreSQL, Redis, and MinIO.

```bash
cp deploy/.env.example deploy/.env
# Edit deploy/.env and replace every placeholder.
chmod 600 deploy/.env
docker compose --env-file deploy/.env config
docker compose --env-file deploy/.env build
docker compose --env-file deploy/.env up -d
docker compose --env-file deploy/.env --profile bootstrap run --rm api-seed
docker compose --env-file deploy/.env ps
```

Run the bootstrap profile only for the first organization owner. It refuses
placeholder/short credentials and never resets an existing password. The seeded
credential must be replaced within 24 hours of the database-recorded bootstrap
time. Its sign-in can open only the password-change screen; it cannot call the
management API. Choose a replacement of at least 16 Unicode code points and no
more than 72 UTF-8 bytes. A successful one-time change revokes every session and
pending enrollment authority held by that user, so sign in again afterward.
Remove the `SEED_*` values from the deployment environment immediately after
the seed command succeeds; deliver the temporary credential separately through
an approved channel. See the runbook before deploying or upgrading an
installation that has not completed this transition.
Changing the manifest signing key requires controlled re-enrollment of players;
players pin its public verification key during pairing.

Point `SCREEN_GOBLIN_HOST` and `PLAYER_HOST` DNS records at the host. Caddy obtains TLS certificates automatically for public names. Do not expose PostgreSQL, Redis, MinIO, or the Caddy admin endpoint to the network.

The MinIO bucket is private and Caddy does not proxy it. Players receive
short-lived, active-device-bound API capabilities in signed manifests. Media
URLs are query-free and players send each capability only as an exact
`Authorization: MediaCapability <token>` header; the API
streams only the exact server-derived object key from its fixed storage endpoint.
Object responses must use identity encoding and match the signed byte length on
the actual stream. The final byte is released only after clean upstream EOF, so
encoded, overlong, truncated, or late-error bodies fail closed.

The Console media inventory is intentionally read-only. This prototype has no
browser upload pipeline, caller-supplied metadata registration route,
multipart parser, or remote-URL ingestion surface. See
[`docs/MEDIA_INGESTION_DESIGN.md`](docs/MEDIA_INGESTION_DESIGN.md) for the
quarantine, scanning, canonicalization, promotion, and recovery gate. Web media,
images, and video must not be enabled through that future boundary without their
documented safe-derivative controls.

## Android player

The web player is the shared playback core. When the Android wrapper is present, build it from `apps/player` using its documented Capacitor/Gradle tasks. CI detects `apps/player/android/gradlew` and builds a debug APK. A signed release requires an organization-controlled keystore and a protected CI environment; keystores must never be committed.

## License and support

ScreenGoblin is licensed under the [MIT License](LICENSE). Security issues should be reported privately as described in [SECURITY.md](SECURITY.md). General contributions follow [CONTRIBUTING.md](CONTRIBUTING.md).
