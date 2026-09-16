# Retention and deletion policy template

## Status

**Draft — unapproved and not implemented. NO-GO for production reliance.** Durations below are proposed engineering defaults, not legal advice or authorization. Privacy, records, security, and operations owners must approve applicable periods and verify automated enforcement.

Local audit field bounds and ordinary row-mutation triggers do not change this
status. Organization deletion still cascades its audit rows, user deletion
still removes actor attribution, and the separately held migration-owner or
PostgreSQL/platform administrator credentials can bypass the trigger even
though the non-owning API runtime role cannot. No expiration job, legal-hold
check, tenant tombstone, deletion ledger, complete export, or independently
retained copy exists.
Release/assignment creator IDs separately retain guarded tenant-scoped
membership attribution after user or membership deletion; this is integrity
support, not approval of a retention period or deletion workflow.

## Principles

- Collect only data required to publish approved signage, operate screens, secure the service, and demonstrate system behavior.
- Do not use the pilot for student, visitor, or sensitive personal information.
- Prefer aggregate health metrics over payloads and stable opaque IDs over names.
- Expiration must cause deletion from active systems and documented aging from backups, subject to an authorized legal/security hold.
- Deletion must be tenant-scoped, auditable, retryable, and safe against cross-tenant identifiers.

## Proposed schedule

| Record                             | Proposed active retention                                                      | Disposal behavior                                                                                                                            | Approval/implementation status                                                |
| ---------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| User account and membership        | While authorized; disable promptly, delete after approved offboarding interval | Revoke sessions and grants, remove membership, preserve tenant-scoped release/assignment provenance and required audit attribution           | **Attribution integrity implemented / timing and public workflow unapproved** |
| Authentication and security audit  | 365 days                                                                       | Append-only expiry job; export only under approved incident/legal process                                                                    | **Unapproved / no verified job**                                              |
| Publishing and configuration audit | 365 days minimum proposal                                                      | Tenant-scoped expiry after governance approval                                                                                               | **Unapproved / no verified job**                                              |
| Raw player heartbeats              | 30 days                                                                        | Aggregate needed fleet trends, then delete raw events                                                                                        | **Unapproved / current schema stores latest state**                           |
| Rate-limit state                   | Window plus small operational margin                                           | Redis TTL, no backup reliance                                                                                                                | **Implementation requires production verification**                           |
| Pairing grants/attempts            | 30 days after grant expiry                                                     | Tenant-scoped, bounded-batch deletion on later enrollment writes; dormant/backlogged tenants require a job                                   | **Implemented opportunistically / governance and exact-time job unapproved**  |
| Enrollment replay records          | 30-day exact-response window; permanent tombstone                              | Bounded response-body compaction; retain key hash, request digest, actor, operation, and status; raw keys and plaintext codes are not stored | **Implemented opportunistically / exact-time compaction unapproved**          |
| Revoked device identity metadata   | 90 days proposal                                                               | Retain non-secret audit evidence; erase credentials and local media                                                                          | **Unapproved / workflow incomplete**                                          |
| Draft content/media                | 30 days after explicit deletion proposal                                       | Remove object and metadata after dependency checks                                                                                           | **Unapproved / deletion workflow incomplete**                                 |
| Published release metadata         | While assigned plus 365 days proposal                                          | Immutable candidate, approval, release, assignment, and withdrawal provenance is preserved; an approved purge workflow is still required     | **Integrity model implemented / timing and purge unapproved**                 |
| Unreferenced media                 | 30-day quarantine proposal                                                     | Delete object and checksum-bound metadata                                                                                                    | **Upload/lifecycle not implemented**                                          |
| Reverse-proxy/application logs     | 30 days proposal                                                               | Central lifecycle deletion; redact secrets before ingestion                                                                                  | **Unapproved / deployment-specific**                                          |
| Backups                            | 35 daily + 12 monthly proposal                                                 | Cryptographic or physical expiration; expired copies inaccessible                                                                            | **Unapproved / off-host design incomplete**                                   |
| CI/security evidence               | 365 days proposal                                                              | Repository/provider lifecycle policy                                                                                                         | **Unapproved / production evidence incomplete**                               |
| Screenshots                        | Disabled                                                                       | No collection or retention                                                                                                                   | **Required pilot setting**                                                    |

## Deletion workflow requirements

1. Authenticate the requester and verify tenant, authority, target type, and hold status.
2. Produce a dry-run inventory with counts, object keys, dependencies, and backup implications.
3. Require separate approval for organization-wide or security-evidence deletion.
4. Execute database changes and outbox/audit records transactionally; object deletion must be idempotent and reconciled.
5. Revoke active sessions/device credentials immediately when identity is removed.
6. Record request ID, actor, scope, reason, timestamps, counts, failures, and completion without recording deleted secrets or payloads.
7. Verify the data is absent from active stores and will age out of backups within the approved window.

## Backup, hold, and restoration rules

- Restoration must not silently resurrect deleted accounts, credentials, pairing codes, or content. Run a post-restore reconciliation against the deletion ledger and revocation state.
- A hold requires an authorized case ID, scope, approver, start/review dates, protected store, and explicit release. Holds must not become indefinite by default.
- Backup operators must not browse tenant content without approved incident/recovery purpose, and every restore must occur in an isolated access-controlled environment.

## Required evidence before approval

- Approved schedule and jurisdiction/contract analysis.
- Automated expiration tests, cross-tenant negative tests, retry/reconciliation tests, and deletion audit tests.
- Object-store lifecycle and backup-aging evidence.
- Documented data subject/organization request process and response ownership.
- Restore test demonstrating that deletion and revocation remain effective.
