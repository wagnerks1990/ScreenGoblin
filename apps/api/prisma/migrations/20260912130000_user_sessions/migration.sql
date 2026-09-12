CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserSession_tokenHash_format" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
CREATE INDEX "UserSession_organizationId_userId_idx" ON "UserSession"("organizationId", "userId");
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

ALTER TABLE "UserSession"
ADD CONSTRAINT "UserSession_organizationId_userId_fkey"
FOREIGN KEY ("organizationId", "userId")
REFERENCES "Membership"("organizationId", "userId")
ON DELETE CASCADE ON UPDATE CASCADE;
