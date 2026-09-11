# ADR-001: Pre-production platform architecture

## Status

Accepted for the pre-production prototype.

## Decision

ScreenGoblin is a TypeScript monorepo with three independently deployable products:

- `apps/console`: React operations console and content studio.
- `apps/api`: Fastify API backed by PostgreSQL and S3-compatible object storage.
- `apps/player`: offline-capable React playback shell wrapped as an Android TV APK with Capacitor and native Kotlin hooks for boot and kiosk behavior.

Shared API payloads live in `packages/contracts`. The player is capability-based so consumer Android TV, managed AOSP, and Amazon Signage hardware can use the same playback core while exposing different management controls.

## Reliability boundaries

- Players activate only complete, checksum-verified manifests.
- The prior manifest remains available as last-known-good content.
- Device commands remain disabled until persistent expiry, acknowledgement, authorization, and auditing are implemented.
- Emergency overrides are separate from normal schedules and have an explicit expiry.
- Device credentials are unique, revocable, hashed at rest, and never placed in URLs.

## Prototype scope

The prototype includes authentication, organization-scoped roles, media metadata, playlists, schedules, device pairing, heartbeats, manifest delivery, audit events, a branded operational console, and an offline-capable Android-oriented player. Object upload/transcoding, production SSO, push delivery, and Amazon partner APIs remain adapter boundaries until deployment credentials and partner approval exist.
