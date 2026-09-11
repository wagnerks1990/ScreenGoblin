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
placeholder/short credentials and never resets an existing password. Remove the
`SEED_*` values from the deployment environment after the owner can sign in.
Changing the manifest signing key requires controlled re-enrollment of players;
players pin its public verification key during pairing.

Point `SCREEN_GOBLIN_HOST` and `PLAYER_HOST` DNS records at the host. Caddy obtains TLS certificates automatically for public names. Do not expose PostgreSQL, Redis, MinIO, or the Caddy admin endpoint to the network.

The MinIO bootstrap grants anonymous read access to the media bucket so standalone players can fetch published assets. Treat media URLs as public. Before storing confidential content, replace this with short-lived signed URLs or an authenticated CDN.

## Android player

The web player is the shared playback core. When the Android wrapper is present, build it from `apps/player` using its documented Capacitor/Gradle tasks. CI detects `apps/player/android/gradlew` and builds a debug APK. A signed release requires an organization-controlled keystore and a protected CI environment; keystores must never be committed.

## License and support

ScreenGoblin is licensed under the [MIT License](LICENSE). Security issues should be reported privately as described in [SECURITY.md](SECURITY.md). General contributions follow [CONTRIBUTING.md](CONTRIBUTING.md).
