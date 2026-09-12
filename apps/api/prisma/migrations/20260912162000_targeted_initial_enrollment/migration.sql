BEGIN;

ALTER TYPE "IdempotencyOperation" ADD VALUE 'SCREEN_ENROLLMENT_CREATE';
ALTER TYPE "IdempotencyOperation" ADD VALUE 'SCREEN_ENROLLMENT_ACTIVATE';

ALTER TABLE "IdempotencyRecord"
  DROP CONSTRAINT "IdempotencyRecord_statusCode",
  ADD CONSTRAINT "IdempotencyRecord_statusCode"
  CHECK (
    ("operation"::text IN ('SCHEDULE_PUBLISH', 'SCREEN_ENROLLMENT_CREATE') AND "statusCode" = 201)
    OR ("operation"::text = 'SCREEN_ENROLLMENT_ACTIVATE' AND "statusCode" = 200)
  );

ALTER TABLE "PairingCode"
  ADD COLUMN "authorizedByMembershipId" TEXT,
  ADD COLUMN "authorizedByAuthenticationEpoch" INTEGER,
  ADD COLUMN "authorizedByAuthorizationEpoch" INTEGER;

-- Replace the earlier NEW_SCREEN-is-always-unbound rule. Terminal legacy
-- NEW_SCREEN history remains representable, while new targeted grants use the
-- same durable target relationship and reason shape as re-enrollment.
ALTER TABLE "PairingCode"
  DROP CONSTRAINT "PairingCode_target_tenant_check",
  ADD CONSTRAINT "PairingCode_target_tenant_check"
  CHECK (
    (
      "purpose" = 'NEW_SCREEN'
      AND "targetScreenId" IS NULL
      AND "targetOrganizationId" IS NULL
      AND "targetScreenReferenceId" IS NULL
      AND "expectedGeneration" IS NULL
      AND "authorizedByUserId" IS NULL
      AND "priorCredentialId" IS NULL
      AND "requestReason" IS NULL
    )
    OR (
      "targetScreenReferenceId" IS NOT NULL
      AND "expectedGeneration" IS NOT NULL
      AND (
        (
          "purpose" = 'NEW_SCREEN'
          AND "expectedGeneration" = 0
          AND "priorCredentialId" IS NULL
          AND "authorizedByMembershipId" IS NOT NULL
          AND "authorizedByAuthenticationEpoch" IS NOT NULL
          AND "authorizedByAuthorizationEpoch" IS NOT NULL
        )
        OR ("purpose" = 'REENROLL' AND "expectedGeneration" > 0)
      )
      AND "authorizedByUserId" IS NOT NULL
      AND "requestReason" IS NOT NULL
      AND LENGTH("requestReason") BETWEEN 5 AND 500
      AND (
        ("targetScreenId" IS NULL AND "targetOrganizationId" IS NULL AND "status" <> 'PENDING')
        OR (
          "targetScreenId" IS NOT NULL
          AND "targetOrganizationId" IS NOT NULL
          AND "targetScreenId" = "targetScreenReferenceId"
          AND "targetOrganizationId" = "organizationId"
        )
      )
    )
  );

-- An unclaimed legacy grant has no durable issuer epoch snapshot. Pairing
-- codes are deliberately short-lived, so revoke rather than guess authority.
UPDATE "PairingAttempt" attempt
SET "cancelledAt" = CURRENT_TIMESTAMP
FROM "PairingCode" pairing_grant
WHERE attempt."pairingCodeId" = pairing_grant."id"
  AND pairing_grant."status" = 'PENDING'
  AND attempt."boundCredentialId" IS NULL
  AND attempt."cancelledAt" IS NULL;

UPDATE "PairingCode"
SET "status" = 'REVOKED'
WHERE "status" = 'PENDING';

ALTER TABLE "PairingCode"
  ADD CONSTRAINT "PairingCode_pending_target_authority_check"
  CHECK (
    "status" <> 'PENDING'
    OR (
      (
        "targetScreenId" IS NULL
        AND "targetOrganizationId" IS NULL
        AND "targetScreenReferenceId" IS NULL
        AND "expectedGeneration" IS NULL
        AND "authorizedByUserId" IS NULL
        AND "authorizedByMembershipId" IS NULL
        AND "authorizedByAuthenticationEpoch" IS NULL
        AND "authorizedByAuthorizationEpoch" IS NULL
      )
      OR (
        "targetScreenId" IS NOT NULL
        AND "targetOrganizationId" IS NOT NULL
        AND "targetScreenReferenceId" IS NOT NULL
        AND "expectedGeneration" IS NOT NULL
        AND "targetOrganizationId" = "organizationId"
        AND "targetScreenReferenceId" = "targetScreenId"
        AND (
          ("purpose" = 'NEW_SCREEN' AND "expectedGeneration" = 0)
          OR ("purpose" = 'REENROLL' AND "expectedGeneration" > 0)
        )
        AND "authorizedByUserId" IS NOT NULL
        AND "authorizedByMembershipId" IS NOT NULL
        AND "authorizedByAuthenticationEpoch" IS NOT NULL
        AND "authorizedByAuthorizationEpoch" IS NOT NULL
      )
    )
  );

CREATE INDEX "PairingCode_organizationId_authorizedByUserId_status_idx"
  ON "PairingCode"("organizationId", "authorizedByUserId", "status");

-- Enrollment maintenance compacts successful replay bodies but keeps the
-- exact-key tombstone. Organization-leading candidate discovery stays bounded
-- without relying on enum values added by this transaction.
CREATE INDEX "IdempotencyRecord_organizationId_compactable_response_idx"
  ON "IdempotencyRecord"("organizationId", "expiresAt", "id")
  WHERE "responseBody" IS NOT NULL;

COMMIT;
