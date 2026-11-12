# Optional Resend communications

Mail is disabled by default. It adds password recovery, opt-in screen status
notifications, and support-mail receipts. Preproduction, Player and emergency
gates remain unchanged. ScreenGoblin is not an emergency notification service.

## Configure and deploy

Use a dedicated verified subdomain such as `signage.example.test`. Enable sending
and receiving in Resend; add its displayed SPF, DKIM and receiving MX records on
that subdomain only. Preserve the organization's root mail DNS. Disable open/click
tracking and enforce TLS. Resend receiving is a provider inbox, not an IMAP/SMTP
mailbox or automatic forwarding service.

Create a domain-restricted sending-only runtime key. An account-wide setup key
must not be used by the application. Configure a webhook at
`https://signage.example.test/api/v1/webhooks/resend` for `email.received`,
`email.delivered`, `email.bounced`, `email.complained` and `email.failed`.
Keep the runtime key and signing secret in protected API configuration only.

Set `MAIL_ENABLED=true` only after rollout checks, plus `RESEND_API_KEY`,
`RESEND_WEBHOOK_SECRET` (`whsec_`), `MAIL_ENCRYPTION_KEY` (independent random
32 bytes, 43 unpadded base64url characters), `MAIL_FROM`, `MAIL_REPLY_TO`, and
`MAIL_RECEIVING_DOMAIN`. Both bare email addresses must use that domain.
`MAIL_OFFLINE_MINUTES` is 5-1440, default 10. `PUBLIC_API_URL` must be the
canonical external HTTPS Console origin. Compose maps mail variables only into
the API; pass a separate protected mail file as an additional `--env-file`.
Never print the resolved environment or place keys in source/browser bundles.

Back up the database and images/configuration. Apply additive migration
`20261112150000_resend_communications` and reconcile runtime database grants.
Retain previous images. Rollback disables mail and restores previous application
images/configuration while retaining new tables; do not downgrade or reset data.
Back up the encryption key with private configuration. To rotate it, stop mail
and cancel/clear queued encrypted jobs through audited maintenance before replacing
it. Do not regenerate it automatically; old payloads cannot use a new key.

Verify anonymous management reads remain 401, invalid webhooks remain 401,
oversized webhook bodies are rejected, and the public landing page stays sign-in.
As an existing owner/admin, open Settings / Notifications, save a unique support
mailbox (for example `support`), and explicitly opt into screen alerts if wanted.
Use "Send a test to my account" and check provider delivery and the actual inbox
separately. Send a non-sensitive inbound message to validate receipts and view
content in Resend. Use a designated test account for recovery acceptance: a reset
changes its password and revokes sessions/pending issuer authority in all tenants.
Automated fake-provider tests do not prove live mail delivery or DNS behavior.

## Recovery authority

Protect and verify the provisioned sign-in mailbox: mailbox access becomes
account recovery authority. Requests return identical generic 202 responses for
eligible/unknown addresses, disabled mail and queue failures. Source/account rate
limits and a maximum of five live links bound requests. New requests do not
invalidate earlier links or change the password. Tokens contain 256 random bits,
are stored as SHA-256 hashes, expire after 15 minutes, and use URL fragments that
Console immediately removes. Only explicit submission consumes a link.

Successful recovery locks the account and memberships, checks the authentication
epoch, consumes sibling tokens, rejects reuse of the current password, changes
the bcrypt hash, clears bootstrap restrictions, revokes all sessions and pending
issuer enrollment grants/attempts, and audits every affected tenant atomically.
Audit failure rolls back the change. Enrolled device credentials are preserved.
Self-service email-address changes and SSO recovery are not implemented.

## Alerts, outbox and delivery

Only opted-in active owners/admins receive generic alerts at their current sign-in
address. A screen must have reported at least once. Offline detection uses the
configured threshold, recovery requires a heartbeat within two minutes, and each
transition has a deduplicated incident. Opting in during an existing incident
applies to future transitions. Recovery requires an attempted offline job.
Messages contain no screen names, media or student information.

AES-256-GCM encrypts queued payloads with the job ID as associated data. Database
time leases and SKIP LOCKED support multiple workers. Dispatch rechecks current
membership, account epoch, recipient, opt-in and incident state. Requests already
in flight cannot be retracted. Provider calls have a ten-second deadline and use
the same idempotency key across retries. At most five attempts honor Retry-After
and bounded backoff, with no retries after ten minutes for reset mail or one hour
for notifications, below Resend's 24-hour deduplication window. Each tick sends
at most ten messages. Complaints disable that recipient's alert preference.
Accepted does not mean delivered. Verified out-of-order delivery events cannot
erase a higher-severity status; early events and provider acknowledgements are
reconciled under the same database lock.

## Inbound isolation and retention

The signed webhook verifies exact UTF-8 raw bytes, bounded headers/body and a
five-minute timestamp window. Only exact, enabled, uniquely mapped workspace
mailboxes create receipts; event/message IDs deduplicate repeats. The API imports
no sender, subject, body, attachment, link or raw webhook payload. Content stays
in Resend under its provider access/retention rules. Inbound mail never publishes,
controls devices, executes instructions, or sends automatic replies. Owners/admins
see only their workspace metadata, at most 30 recent deliveries and receipts.

The running worker prunes reset/job metadata after seven days, inbound receipts
after seven days and early delivery receipts after one day, in bounded batches.
It clears ciphertext on acceptance, cancellation, failure or expiry. Per-workspace
job history is capped around 5,000 (completed rows may be evicted earlier), inbound
receipts at 1,000, and early provider receipts at 5,000 globally. Audit history
follows the existing policy. With mail disabled the worker does not run: arrange
an audited operator purge of expired metadata. Provider outages, full queues, DNS
failure and stopped workers can prevent delivery. Keep independent monitoring and
the existing operator account-recovery process.
