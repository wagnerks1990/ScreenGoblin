BEGIN;
-- CreateEnum
CREATE TYPE "MailKind" AS ENUM ('PASSWORD_RESET', 'PASSWORD_CHANGED', 'SCREEN_OFFLINE', 'SCREEN_RECOVERED', 'TEST');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PasswordResetRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "authenticationEpoch" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailPreference" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offlineAlertsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailPreference_pkey" PRIMARY KEY ("organizationId","userId")
);

-- CreateTable
CREATE TABLE "MailInbox" (
    "organizationId" TEXT NOT NULL,
    "address" VARCHAR(254) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailInbox_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "InboundMailReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerEmailId" VARCHAR(64) NOT NULL,
    "eventHash" VARCHAR(64) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMailReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailJob" (
    "screenId" TEXT,
    "incidentId" VARCHAR(36),
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authenticationEpoch" INTEGER NOT NULL,
    "kind" "MailKind" NOT NULL,
    "status" "MailStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" VARCHAR(64) NOT NULL,
    "payloadEncrypted" TEXT,
    "resetTokenHash" VARCHAR(64),
    "providerEmailId" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "leaseToken" VARCHAR(36),
    "lockedUntil" TIMESTAMP(3),
    "failureCode" VARCHAR(40),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetMailState" (
    "screenId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "offline" BOOLEAN NOT NULL,
    "incidentId" VARCHAR(36) NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetMailState_pkey" PRIMARY KEY ("screenId")
);

-- CreateTable
CREATE TABLE "MailDeliveryReceipt" (
    "eventHash" VARCHAR(64) NOT NULL,
    "providerEmailId" VARCHAR(64) NOT NULL,
    "status" "MailStatus" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailDeliveryReceipt_pkey" PRIMARY KEY ("eventHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetRequest_tokenHash_key" ON "PasswordResetRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetRequest_expiresAt_idx" ON "PasswordResetRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "PasswordResetRequest_userId_expiresAt_idx" ON "PasswordResetRequest"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailInbox_address_key" ON "MailInbox"("address");

-- CreateIndex
CREATE INDEX "InboundMailReceipt_organizationId_receivedAt_idx" ON "InboundMailReceipt"("organizationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMailReceipt_organizationId_providerEmailId_key" ON "InboundMailReceipt"("organizationId", "providerEmailId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMailReceipt_organizationId_eventHash_key" ON "InboundMailReceipt"("organizationId", "eventHash");

-- CreateIndex
CREATE UNIQUE INDEX "MailJob_dedupeKey_key" ON "MailJob"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "MailJob_providerEmailId_key" ON "MailJob"("providerEmailId");

-- CreateIndex
CREATE INDEX "MailJob_status_availableAt_idx" ON "MailJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "MailJob_organizationId_createdAt_idx" ON "MailJob"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MailJob_expiresAt_idx" ON "MailJob"("expiresAt");

-- CreateIndex
CREATE INDEX "FleetMailState_checkedAt_idx" ON "FleetMailState"("checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetMailState_screenId_organizationId_key" ON "FleetMailState"("screenId", "organizationId");

-- CreateIndex
CREATE INDEX "MailDeliveryReceipt_providerEmailId_receivedAt_idx" ON "MailDeliveryReceipt"("providerEmailId", "receivedAt");

-- CreateIndex
CREATE INDEX "MailDeliveryReceipt_receivedAt_idx" ON "MailDeliveryReceipt"("receivedAt");

-- AddForeignKey
ALTER TABLE "PasswordResetRequest" ADD CONSTRAINT "PasswordResetRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailPreference" ADD CONSTRAINT "MailPreference_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "Membership"("organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailInbox" ADD CONSTRAINT "MailInbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMailReceipt" ADD CONSTRAINT "InboundMailReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "MailInbox"("organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailJob" ADD CONSTRAINT "MailJob_screenId_organizationId_fkey" FOREIGN KEY ("screenId", "organizationId") REFERENCES "Screen"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailJob" ADD CONSTRAINT "MailJob_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "Membership"("organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetMailState" ADD CONSTRAINT "FleetMailState_screenId_organizationId_fkey" FOREIGN KEY ("screenId", "organizationId") REFERENCES "Screen"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;



-- Account recovery and mail queues contain capabilities and must remain bounded.
ALTER TABLE "PasswordResetRequest"
  ADD CONSTRAINT "password_reset_hash_valid" CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "password_reset_window_valid" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '15 minutes'),
  ADD CONSTRAINT "password_reset_epoch_valid" CHECK ("authenticationEpoch" >= 0);
ALTER TABLE "MailInbox"
  ADD CONSTRAINT "mail_inbox_address_normalized" CHECK (address = lower(address) AND position(chr(10) in address)=0 AND position(chr(13) in address)=0);
ALTER TABLE "InboundMailReceipt"
  ADD CONSTRAINT "mail_inbound_event_hash_valid" CHECK ("eventHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "MailJob"
  ADD CONSTRAINT "mail_job_hash_valid" CHECK ("dedupeKey" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "mail_job_attempts_bounded" CHECK (attempts BETWEEN 0 AND 5),
  ADD CONSTRAINT "mail_job_epoch_valid" CHECK ("authenticationEpoch" >= 0),
  ADD CONSTRAINT "mail_job_window_bounded" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '23 hours'),
  ADD CONSTRAINT "mail_job_ciphertext_bounded" CHECK ("payloadEncrypted" IS NULL OR octet_length("payloadEncrypted") BETWEEN 29 AND 16000),
  ADD CONSTRAINT "mail_job_pending_payload_present" CHECK (status NOT IN ('PENDING','SENDING') OR "payloadEncrypted" IS NOT NULL),
  ADD CONSTRAINT "mail_job_lease_valid" CHECK (
    (status='SENDING' AND "leaseToken" IS NOT NULL AND "lockedUntil" IS NOT NULL)
    OR (status<>'SENDING' AND "leaseToken" IS NULL AND "lockedUntil" IS NULL)),
  ADD CONSTRAINT "mail_job_reset_binding" CHECK (
    (kind='PASSWORD_RESET' AND "resetTokenHash" IS NOT NULL AND "resetTokenHash" ~ '^[a-f0-9]{64}$')
    OR (kind<>'PASSWORD_RESET' AND "resetTokenHash" IS NULL)),
  ADD CONSTRAINT "mail_job_screen_binding" CHECK (
    (kind IN ('SCREEN_OFFLINE','SCREEN_RECOVERED') AND "screenId" IS NOT NULL AND "incidentId" IS NOT NULL)
    OR (kind NOT IN ('SCREEN_OFFLINE','SCREEN_RECOVERED') AND "screenId" IS NULL AND "incidentId" IS NULL));
ALTER TABLE "MailDeliveryReceipt"
  ADD CONSTRAINT "mail_delivery_event_hash_valid" CHECK ("eventHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "mail_delivery_status_valid" CHECK (status IN ('DELIVERED','FAILED','BOUNCED','COMPLAINED'));

COMMIT;
