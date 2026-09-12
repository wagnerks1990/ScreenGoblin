# Data-flow inventory

## Status

**Draft — unapproved. This document does not authorize production or PII use.** Validate it against the deployed configuration, vendors, contracts, and network design before any pilot. The approved pilot profile remains non-PII and non-life-safety only.

## Data classification

| Class                       | Examples                                                                                   | Pilot rule                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Public content              | Approved signage images, videos, public event copy                                         | Allowed after human publishing review                                                  |
| Operational                 | Screen name, location label, player version, heartbeat, storage, network type              | Allowed when minimized; treat as internal                                              |
| Security                    | Password hashes, session/device credentials, signing material, audit records, IP addresses | Restricted; never expose in UI, logs, URLs, or exports without an approved need        |
| Personal information        | Names, email addresses, IP addresses when linkable to a person                             | Staff account minimum only; approval and notice required                               |
| Student/visitor information | Student names, images, identifiers, schedules, behavior, attendance, demographics          | Prohibited in the pilot                                                                |
| Secrets                     | JWT/signing keys, database and object-store credentials, pairing pepper                    | Secret manager only; never content, source control, telemetry, or backup documentation |

## System inventory

| Component          | Receives                                                 | Stores                                                                          | Sends                                                             | Boundary and current gap                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console browser    | Staff credentials, content metadata, operational state   | In-memory access token and UI state                                             | TLS API requests                                                  | Production SSO/MFA and scoped authorization are not implemented                                                                                                                                                                                                               |
| Control-plane API  | Auth, publishing metadata, enrollment, heartbeat         | PostgreSQL records and audit events                                             | Database, Redis, private object storage, signed manifests         | P-256 proof, revocation, staged targeted re-enrollment, and assignment-bound private media delivery exist; upload/quarantine/scanning, scoped approval, attestation, automatic overlapping rotation, verified erasure, and complete transactional audit coverage remain gates |
| PostgreSQL         | Accounts, memberships, screens, schedules, audit records | Authoritative control-plane data                                                | API query results and backups                                     | Tenant-safe composite constraints and approved retention jobs remain gates                                                                                                                                                                                                    |
| Redis              | Rate-limit and ephemeral coordination state              | Non-authoritative short-lived keys                                              | API decisions                                                     | Production requires private networking, authentication where supported, and monitored availability                                                                                                                                                                            |
| Object storage     | Approved media objects and metadata                      | Private media and backup objects                                                | Media bytes to the API; backup restore                            | The API mediates assignment-bound private delivery; upload/quarantine/scanning and approved lifecycle rules remain gates                                                                                                                                                      |
| Reverse proxy      | TLS requests and limited connection metadata             | Access logs according to deployment policy                                      | API/static responses                                              | Logs must redact credentials and follow approved retention                                                                                                                                                                                                                    |
| Player             | Pairing/re-enrollment material, manifests, media         | Keystore identity, public credential metadata, active and last-known-good media | Pairing candidates, proof challenges, heartbeat, manifest polling | Native proof and explicit fresh-key re-enrollment are implemented; attestation, offline recall, automatic overlapping rotation, verified erasure, and physical-device validation remain gates                                                                                 |
| CI/release systems | Source, test results, image metadata                     | Logs, SBOMs, scan and build artifacts                                           | Images and evidence artifacts                                     | Production signing, provenance, protected environments, and retention approvals remain gates                                                                                                                                                                                  |

## Expected flows

1. **Staff authentication:** browser → reverse proxy → API → PostgreSQL. Passwords are used only for verification and must never enter logs. Tokens are returned only to the authenticated browser.
2. **Content preparation:** approved external process → server-derived key in
   private object storage → bounded API metadata. The Console inventory is
   read-only; browser upload and web media are disabled. Registration and
   publication enforce type, size, hash, expiry, and aggregate release limits,
   but no production-safe upload, quarantine, scanning, transcoding, or object
   lifecycle pipeline exists.
3. **Publish and assignment:** authorized user → API → immutable release records → audit transaction. Ordinary immutable release records are implemented; scoped grants, reviewer/publisher separation, and approval records remain target-state work.
4. **Device enrollment:** player → API with short-lived pairing code, canonical P-256 public identity, and transcript-bound proof → PostgreSQL. Production returns public credential metadata rather than a bearer token. A stolen initial-enrollment code is still first-winner authority because operator confirmation and server-verified attestation are incomplete.
5. **Playback delivery:** player → API for a fresh manifest-bound proof
   challenge → screen-bound signed manifest → short-lived assignment-bound API
   media capability → API-mediated private object read. The API rechecks the
   active credential and latest assignment before reading the server-derived
   object key; the Player verifies the manifest signature and asset hashes
   before activation and retains last-known-good content.
6. **Telemetry:** player → API for a fresh canonical-heartbeat-bound proof challenge → PostgreSQL/monitoring. Collect operational health only; no camera, microphone, audience analytics, demographic inference, or nearby-device tracking.
7. **Device revocation:** authorized owner/admin → API → transactionally revoked public-key credential, invalidated challenges, screen marker, and audit event. This blocks online proof use but cannot recall or erase content from an offline player.
8. **Targeted device re-enrollment:** authorized owner/admin → API → old identity immediately revoked/detached, challenges and stale grants invalidated, credential generation advanced, and target-bound grant audited. Player explicit local action → fresh Keystore key and transcript-bound proof → pending candidate only. A separate current owner/admin compares the exact fingerprint with the physical Player → activation transaction creates one new credential on the same screen, preserves assignments, consumes competing authority, and audits completion. Codes, signatures, challenges, and private material must not enter management views or logs. This is manual zero-overlap recovery and does not prove physical identity or erase offline state.
9. **Backup and recovery:** PostgreSQL/object storage → encrypted off-host backup → isolated restoration. Production storage, key custody, and restore evidence are not approved.

## Third parties and transfers

No third-party processor, subprocessors, analytics provider, crash reporter, CDN, AI provider, or external monitoring service is approved by this draft. Before enabling one, record its purpose, fields, region, retention, deletion process, contract/DPA, breach terms, access model, and owner. AI must never receive secrets, device credentials, private infrastructure details, student information, or unpublished sensitive content.

## Validation and approval record

| Required review                       | Owner | Evidence                     | Status                         |
| ------------------------------------- | ----- | ---------------------------- | ------------------------------ |
| Architecture and actual network paths | TBD   | Diagram/config review        | **NO-GO — not reviewed**       |
| Privacy and data classification       | TBD   | Privacy decision record      | **NO-GO — not approved**       |
| Security controls and threat model    | TBD   | Security assessment          | **NO-GO — not approved**       |
| Vendors/subprocessors and contracts   | TBD   | Approved register/agreements | **NO-GO — none approved here** |
