CREATE TYPE "LoginFailureReason" AS ENUM ('INVALID_CREDENTIALS', 'RATE_LIMITED');

CREATE TABLE "LoginFailureEvent" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "reason" "LoginFailureReason" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginFailureEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LoginFailureEvent_accountKey_format" CHECK ("accountKey" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "LoginFailureEvent_sourceKey_format" CHECK ("sourceKey" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "LoginFailureEvent_accountKey_occurredAt_idx" ON "LoginFailureEvent"("accountKey", "occurredAt");
CREATE INDEX "LoginFailureEvent_sourceKey_occurredAt_idx" ON "LoginFailureEvent"("sourceKey", "occurredAt");
CREATE INDEX "LoginFailureEvent_occurredAt_idx" ON "LoginFailureEvent"("occurredAt");
