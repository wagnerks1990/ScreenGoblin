BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "DeviceCredential"
    WHERE ("liveScreenId" IS NULL) <> ("liveScreenOrganizationId" IS NULL)
       OR ("revokedAt" IS NOT NULL AND ("liveScreenId" IS NOT NULL OR "liveScreenOrganizationId" IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'DeviceCredential live/revoked invariants violated; repair explicitly before migration';
  END IF;
END $$;

CREATE TYPE "PairingPurpose" AS ENUM ('NEW_SCREEN', 'REENROLL');

CREATE TABLE "DeviceKeyTombstone" (
  "keyId" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceKeyTombstone_pkey" PRIMARY KEY ("keyId")
);
INSERT INTO "DeviceKeyTombstone" ("keyId", "firstSeenAt")
SELECT "keyId", MIN("createdAt") FROM "DeviceCredential" GROUP BY "keyId";

ALTER TABLE "Screen"
  ADD COLUMN "credentialGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PairingCode"
  ADD COLUMN "purpose" "PairingPurpose" NOT NULL DEFAULT 'NEW_SCREEN',
  ADD COLUMN "targetScreenId" TEXT,
  ADD COLUMN "targetScreenReferenceId" TEXT,
  ADD COLUMN "targetOrganizationId" TEXT,
  ADD COLUMN "expectedGeneration" INTEGER,
  ADD COLUMN "authorizedByUserId" TEXT,
  ADD COLUMN "priorCredentialId" TEXT,
  ADD COLUMN "requestReason" TEXT;

ALTER TABLE "PairingAttempt"
  ADD COLUMN "provedAt" TIMESTAMP(3),
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "installationId" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "osVersion" TEXT,
  ADD COLUMN "playerVersion" TEXT;

ALTER TABLE "PairingAttempt"
  DROP CONSTRAINT "PairingAttempt_consumption_check";
ALTER TABLE "PairingAttempt"
  ADD CONSTRAINT "PairingAttempt_consumption_check" CHECK (
    ("consumedAt" IS NULL AND "activatedAt" IS NULL AND "boundCredentialId" IS NULL)
    OR ("consumedAt" IS NOT NULL AND "activatedAt" IS NULL AND "boundCredentialId" IS NOT NULL
      AND "consumedAt" >= "createdAt" AND "consumedAt" <= "expiresAt")
    OR ("consumedAt" IS NULL AND "activatedAt" IS NOT NULL AND "boundCredentialId" IS NOT NULL
      AND "provedAt" IS NOT NULL AND "activatedAt" >= "provedAt")
  );
ALTER TABLE "PairingAttempt"
  ADD CONSTRAINT "PairingAttempt_proved_check" CHECK (
    "provedAt" IS NULL OR ("provedAt" >= "createdAt" AND "provedAt" <= "expiresAt")
  );

ALTER TABLE "PairingCode"
  ADD CONSTRAINT "PairingCode_targetScreenId_targetOrganizationId_fkey"
  FOREIGN KEY ("targetScreenId", "targetOrganizationId")
  REFERENCES "Screen"("id", "organizationId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PairingCode"
  ADD CONSTRAINT "PairingCode_target_tenant_check"
  CHECK (
    ("purpose" = 'NEW_SCREEN' AND "targetScreenId" IS NULL AND "targetOrganizationId" IS NULL AND "targetScreenReferenceId" IS NULL AND "expectedGeneration" IS NULL AND "authorizedByUserId" IS NULL AND "priorCredentialId" IS NULL AND "requestReason" IS NULL)
    OR
    ("purpose" = 'REENROLL' AND "targetScreenReferenceId" IS NOT NULL AND "expectedGeneration" IS NOT NULL AND "authorizedByUserId" IS NOT NULL AND LENGTH("requestReason") BETWEEN 5 AND 500
      AND (("targetScreenId" IS NULL AND "targetOrganizationId" IS NULL AND "status" <> 'PENDING')
        OR ("targetScreenId" = "targetScreenReferenceId" AND "targetOrganizationId" = "organizationId")))
  );

CREATE INDEX "PairingCode_targetScreenId_targetOrganizationId_status_idx"
  ON "PairingCode"("targetScreenId", "targetOrganizationId", "status");

CREATE UNIQUE INDEX "PairingCode_one_pending_reenrollment_per_screen"
  ON "PairingCode"("targetScreenId", "targetOrganizationId")
  WHERE "purpose" = 'REENROLL' AND "status" = 'PENDING';

ALTER TABLE "DeviceCredential"
  ADD CONSTRAINT "DeviceCredential_live_pair_check"
  CHECK (("liveScreenId" IS NULL) = ("liveScreenOrganizationId" IS NULL));
ALTER TABLE "DeviceCredential"
  ADD CONSTRAINT "DeviceCredential_revoked_detached_check"
  CHECK ("revokedAt" IS NULL OR ("liveScreenId" IS NULL AND "liveScreenOrganizationId" IS NULL));

COMMIT;
