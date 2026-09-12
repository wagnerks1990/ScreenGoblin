# Private media ingestion design gate

Status: design only. No upload endpoint or production ingestion worker exists.
The deprecated caller-supplied metadata registration route is disabled by
default and cannot be enabled in production.

## Why ingestion is a separate tranche

PostgreSQL and S3-compatible object storage do not share a transaction. A
synchronous upload, scan, copy, and row insert would leave untracked objects or
metadata after crashes. The API also has no streaming multipart boundary,
malware-scanner dependency, image sanitizer, or video transcoder. Enabling an
upload before those pieces exist would misrepresent a metadata check as content
security.

## Proposed authorization and API boundary

`POST /api/v1/media-ingestions` will require an authenticated current session
and a live `OWNER`, `ADMIN`, or `PUBLISHER` membership rechecked in the same
transaction that creates the ingestion record. The server, never the client,
will derive `organizationId`. A future optional `locationId` must be resolved
through an organization-scoped location grant in that transaction; absence of
the location model means the first implementation remains organization-wide
and must not accept a client-asserted location.

The endpoint will require an idempotency key whose deployment-secret HMAC is
stored under a unique `(organizationId, idempotencyKeyHash)` constraint. It will
return the original operation for an exact retry and reject reuse with different
request metadata. The server generates the ingestion ID, asset ID, quarantine
key, and final immutable key. Supplied filenames and path components are
ignored and never logged or persisted.

Uploads remain disabled by default. Production startup may enable them only
when the private quarantine store, durable worker, and fail-closed scanner are
configured and healthy.

## Durable state and object visibility

Add an `MediaIngestion` row with tenant-scoped unique identifiers and these
states:

`RECEIVING -> QUARANTINED -> SCANNING -> CLEAN -> PROMOTING -> PROMOTED`

Terminal states are `REJECTED`, `FAILED`, and `EXPIRED`. Each transition uses a
compare-and-swap version, bounded retry count, last safe reason code, and next
attempt time. Do not persist scanner diagnostics, filenames, object bytes,
credentials, or signed URLs.

The quarantine bucket uses a distinct credential and has no anonymous, player,
delivery-API, or Caddy access. Raw uploads never enter the delivery bucket.
After scanning and safe canonicalization, the worker writes a new object to the
server-derived final key. A single PostgreSQL transaction then rechecks tenant
authorization and ingestion state, creates the immutable `MediaAsset`, changes
the ingestion to `PROMOTED`, and appends the promotion audit. Player manifests
can observe only committed `MediaAsset` rows. A crash after final-object write
but before the transaction leaves an unreachable deterministic orphan; retry
uses the same digest key and verifies its exact size and digest, while a bounded
reconciler deletes unreferenced objects. This is reader-visible atomicity, not a
false claim of a distributed S3/PostgreSQL transaction.

## Streaming and content policy

The ingress proxy and API enforce the same small request-header limit and a
strict per-object byte maximum. The receiver counts every chunk, aborts the
connection and quarantine write at `limit + 1`, rejects missing/invalid length,
and checks the final count. SHA-256 and size are derived while streaming; client
values are never accepted. No component fetches a supplied URL.

Type detection is based on bounded leading bytes plus complete safe parsing,
not extension, filename, or declared MIME. Initial policy should enable only
canonical JSON templates: UTF-8 without BOM ambiguity, duplicate-key rejection,
the existing template schema, bounded nesting/string lengths, and deterministic
serialization to a newly written clean object. A scanner still runs first and
production fails closed when it is unavailable, times out, returns unknown, or
uses a stale signature set.

JPEG and PNG remain disabled until a pinned, sandboxed decoder fully decodes
with pixel/dimension/frame/decompression limits, discards all metadata and
profiles, and re-encodes a new image. MP4 remains disabled until a pinned,
sandboxed transcoder enforces duration, resolution, frame-rate, stream-count,
codec, and resource limits and produces a new playable derivative. Original
image/video bytes are never promoted. Web/HTML/SVG and active documents remain
unsupported.

## Scanner interface and failure handling

The worker depends on a versioned `MalwareScanner.scan(stream, context)`
interface returning only `clean`, `infected`, or `unavailable`, plus a bounded
engine/signature version. Production readiness fails if the scanner is absent,
unhealthy, stale, or cannot be reached over its private network. Calls have
strict connect, total, and response limits. `infected`, timeout, malformed
response, and unavailable all prevent promotion.

Creation, scan rejection/unavailability, promotion, retry exhaustion, expiry,
and cleanup append organization-scoped audit events with ingestion/asset IDs and
bounded reason codes only. Cleanup deletes quarantine objects after rejection,
expiry, or successful promotion; retries are idempotent and lease-owned so two
workers cannot promote concurrently. Deletion failures remain queued for the
reconciler and never make raw bytes reachable.

## Required implementation evidence

- Unit: chunked overflow, forged length, truncation, filename/path attacks,
  magic/MIME mismatch, malformed JSON, duplicate keys, scanner timeout and every
  non-clean result, deterministic IDs/keys, retry and lease races.
- API/Memory: role and cross-tenant denial, disabled-default behavior,
  idempotency conflict/replay, redacted audits and logs.
- PostgreSQL: transition compare-and-swap, unique idempotency, transactional
  `MediaAsset` plus audit promotion, rollback, tenant/location joins, cleanup
  leases, and migration preflights.
- MinIO/Compose: separate credentials and buckets, anonymous/player/API denial
  for quarantine, overflow cleanup, scanner outage fail-closed, exact clean
  derivative promotion, raw-object denial, retry after injected worker crash,
  and orphan reconciliation.
- Recovery: in-flight state, audit history, clean final objects, and quarantine
  retention restore without making any raw object playable.

Until this matrix passes, `UPLOAD_ENABLED=false`, images and video remain
disabled, and the pre-production upload gate remains unchecked.
