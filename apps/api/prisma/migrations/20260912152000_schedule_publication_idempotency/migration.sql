CREATE TYPE "IdempotencyOperation" AS ENUM ('SCHEDULE_PUBLISH');

CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "operation" "IdempotencyOperation" NOT NULL,
    "keyHash" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "requestDigestSha256" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdempotencyRecord_keyHash_format" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "IdempotencyRecord_requestDigestSha256_format" CHECK ("requestDigestSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "IdempotencyRecord_statusCode" CHECK ("statusCode" = 201),
    CONSTRAINT "IdempotencyRecord_expiry" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "IdempotencyRecord_organizationId_operation_keyHash_key"
ON "IdempotencyRecord"("organizationId", "operation", "keyHash");

CREATE INDEX "IdempotencyRecord_expiresAt_idx"
ON "IdempotencyRecord"("expiresAt");

ALTER TABLE "IdempotencyRecord"
ADD CONSTRAINT "IdempotencyRecord_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
