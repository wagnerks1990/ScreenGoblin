-- Older API versions could leave a revoked screen ONLINE with its detached
-- credential's heartbeat snapshot, or synthesize lastSeenAt during replacement
-- activation. Heal only states that are authoritatively identifiable: an
-- explicit revocation marker, or the exact re-enrollment activation tuple whose
-- lastSeenAt equals activatedAt. Unequal heartbeats and initial enrollment are
-- untouched; the stale-state guard makes this update idempotent.
UPDATE "Screen" AS screen
SET "status" = 'OFFLINE'::"ScreenStatus",
    "lastSeenAt" = NULL,
    "manifestVersion" = NULL,
    "nowPlayingAssetId" = NULL,
    "uptimeSeconds" = NULL,
    "freeStorageBytes" = NULL,
    "networkType" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE (
       screen."status" <> 'OFFLINE'::"ScreenStatus"
       OR screen."lastSeenAt" IS NOT NULL
       OR screen."manifestVersion" IS NOT NULL
       OR screen."nowPlayingAssetId" IS NOT NULL
       OR screen."uptimeSeconds" IS NOT NULL
       OR screen."freeStorageBytes" IS NOT NULL
       OR screen."networkType" IS NOT NULL
     )
  AND (
    screen."credentialRevokedAt" IS NOT NULL
    OR EXISTS (
     SELECT 1
     FROM "DeviceCredential" AS credential
     INNER JOIN "PairingAttempt" AS attempt
       ON attempt."boundCredentialId" = credential."id"
     WHERE credential."liveScreenId" = screen."id"
       AND credential."liveScreenOrganizationId" = screen."organizationId"
       AND credential."revokedAt" IS NULL
       AND attempt."activatedAt" IS NOT NULL
       AND screen."lastSeenAt" = attempt."activatedAt"
    )
  );
