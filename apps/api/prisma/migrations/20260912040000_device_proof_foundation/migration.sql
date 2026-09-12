-- Add the server-side persistence foundation for device proof-of-possession.
-- Legacy bearer columns deliberately remain during the staged re-enrollment.
BEGIN;

CREATE TYPE "DeviceAuthOperation" AS ENUM ('HEARTBEAT', 'MANIFEST');

CREATE TABLE "DeviceCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "screenId" TEXT NOT NULL,
    "liveScreenId" TEXT,
    "liveScreenOrganizationId" TEXT,
    "keyId" TEXT NOT NULL,
    "publicKeySpki" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'ES256',
    "securityLevel" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCredential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeviceCredential_keyId_check"
      CHECK ("keyId" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "DeviceCredential_publicKeySpki_check"
      CHECK (octet_length("publicKeySpki") BETWEEN 80 AND 256),
    CONSTRAINT "DeviceCredential_algorithm_check"
      CHECK ("algorithm" = 'ES256'),
    CONSTRAINT "DeviceCredential_securityLevel_check"
      CHECK ("securityLevel" IN ('strongbox', 'trusted-environment', 'software', 'unknown-secure', 'unknown')),
    CONSTRAINT "DeviceCredential_expiry_check"
      CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt"),
    CONSTRAINT "DeviceCredential_revocation_check"
      CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt"),
    CONSTRAINT "DeviceCredential_live_screen_check"
      CHECK (
        ("liveScreenId" IS NULL AND "liveScreenOrganizationId" IS NULL)
        OR (
          "liveScreenId" IS NOT NULL
          AND "liveScreenOrganizationId" IS NOT NULL
          AND "liveScreenId" = "screenId"
          AND "liveScreenOrganizationId" = "organizationId"
        )
      )
);

CREATE TABLE "DeviceAuthChallenge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "challengeHashSha256" TEXT NOT NULL,
    "operation" "DeviceAuthOperation" NOT NULL,
    "requestDigestSha256" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAuthChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeviceAuthChallenge_id_check"
      CHECK ("id" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "DeviceAuthChallenge_hash_check"
      CHECK ("challengeHashSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "DeviceAuthChallenge_request_digest_check"
      CHECK ("requestDigestSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "DeviceAuthChallenge_expiry_check"
      CHECK (
        "expiresAt" > "createdAt"
        AND "expiresAt" <= "createdAt" + INTERVAL '60 seconds'
      ),
    CONSTRAINT "DeviceAuthChallenge_consumption_check"
      CHECK (
        "consumedAt" IS NULL
        OR ("consumedAt" >= "createdAt" AND "consumedAt" <= "expiresAt")
      )
);

CREATE TABLE "PairingAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pairingCodeId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "publicKeySpki" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'ES256',
    "securityLevel" TEXT NOT NULL,
    "credentialExpiresAt" TIMESTAMP(3),
    "challengeHashSha256" TEXT NOT NULL,
    -- Domain-separated HMAC-SHA256 using PAIRING_CODE_PEPPER.
    "transcriptDigestSha256" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "boundCredentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PairingAttempt_id_check"
      CHECK ("id" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "PairingAttempt_keyId_check"
      CHECK ("keyId" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "PairingAttempt_publicKeySpki_check"
      CHECK (octet_length("publicKeySpki") BETWEEN 80 AND 256),
    CONSTRAINT "PairingAttempt_algorithm_check" CHECK ("algorithm" = 'ES256'),
    CONSTRAINT "PairingAttempt_securityLevel_check"
      CHECK ("securityLevel" IN ('strongbox', 'trusted-environment', 'software', 'unknown-secure', 'unknown')),
    CONSTRAINT "PairingAttempt_credential_expiry_check"
      CHECK ("credentialExpiresAt" IS NULL OR "credentialExpiresAt" > "createdAt"),
    CONSTRAINT "PairingAttempt_hash_check"
      CHECK ("challengeHashSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PairingAttempt_transcript_check"
      CHECK ("transcriptDigestSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PairingAttempt_expiry_check"
      CHECK (
        "expiresAt" > "createdAt"
        AND "expiresAt" <= "createdAt" + INTERVAL '45 seconds'
      ),
    CONSTRAINT "PairingAttempt_consumption_check"
      CHECK (
        ("consumedAt" IS NULL AND "boundCredentialId" IS NULL)
        OR (
          "consumedAt" IS NOT NULL
          AND "boundCredentialId" IS NOT NULL
          AND "consumedAt" >= "createdAt"
          AND "consumedAt" <= "expiresAt"
        )
      )
);

CREATE UNIQUE INDEX "DeviceCredential_keyId_key"
  ON "DeviceCredential"("keyId");
CREATE UNIQUE INDEX "DeviceCredential_id_organizationId_key"
  ON "DeviceCredential"("id", "organizationId");
CREATE INDEX "DeviceCredential_organizationId_liveScreenId_revokedAt_expiresAt_idx"
  ON "DeviceCredential"("organizationId", "liveScreenId", "revokedAt", "expiresAt");
CREATE INDEX "DeviceCredential_organizationId_screenId_createdAt_idx"
  ON "DeviceCredential"("organizationId", "screenId", "createdAt");
CREATE UNIQUE INDEX "DeviceCredential_liveScreenId_liveScreenOrganizationId_key"
  ON "DeviceCredential"("liveScreenId", "liveScreenOrganizationId");

CREATE UNIQUE INDEX "DeviceAuthChallenge_challengeHashSha256_key"
  ON "DeviceAuthChallenge"("challengeHashSha256");
CREATE INDEX "DeviceAuthChallenge_organizationId_credentialId_expiresAt_consumedAt_idx"
  ON "DeviceAuthChallenge"("organizationId", "credentialId", "expiresAt", "consumedAt");
CREATE INDEX "DeviceAuthChallenge_expiresAt_idx"
  ON "DeviceAuthChallenge"("expiresAt");
CREATE UNIQUE INDEX "PairingCode_id_organizationId_key"
  ON "PairingCode"("id", "organizationId");
CREATE UNIQUE INDEX "PairingAttempt_challengeHashSha256_key"
  ON "PairingAttempt"("challengeHashSha256");
CREATE UNIQUE INDEX "PairingAttempt_boundCredentialId_organizationId_key"
  ON "PairingAttempt"("boundCredentialId", "organizationId");
CREATE INDEX "PairingAttempt_organizationId_pairingCodeId_expiresAt_consumedAt_idx"
  ON "PairingAttempt"("organizationId", "pairingCodeId", "expiresAt", "consumedAt");
CREATE INDEX "PairingAttempt_expiresAt_idx"
  ON "PairingAttempt"("expiresAt");

ALTER TABLE "DeviceCredential" ADD CONSTRAINT "DeviceCredential_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceCredential" ADD CONSTRAINT "DeviceCredential_liveScreenId_liveScreenOrganizationId_fkey"
  FOREIGN KEY ("liveScreenId", "liveScreenOrganizationId")
  REFERENCES "Screen"("id", "organizationId")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DeviceAuthChallenge" ADD CONSTRAINT "DeviceAuthChallenge_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceAuthChallenge" ADD CONSTRAINT "DeviceAuthChallenge_credentialId_organizationId_fkey"
  FOREIGN KEY ("credentialId", "organizationId")
  REFERENCES "DeviceCredential"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PairingAttempt" ADD CONSTRAINT "PairingAttempt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PairingAttempt" ADD CONSTRAINT "PairingAttempt_pairingCodeId_organizationId_fkey"
  FOREIGN KEY ("pairingCodeId", "organizationId")
  REFERENCES "PairingCode"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PairingAttempt" ADD CONSTRAINT "PairingAttempt_boundCredentialId_organizationId_fkey"
  FOREIGN KEY ("boundCredentialId", "organizationId")
  REFERENCES "DeviceCredential"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
