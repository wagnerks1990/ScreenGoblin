BEGIN;

-- Match the application writer order (Membership, then AccessGrant) before
-- taking AccessGrant's DDL lock. This prevents a concurrent membership writer
-- from holding Membership while waiting behind this migration on AccessGrant.
LOCK TABLE "Membership" IN EXCLUSIVE MODE;

CREATE TYPE "AccessGrantCreatorKind" AS ENUM ('USER', 'SYSTEM');

ALTER TABLE "AccessGrant"
  DROP CONSTRAINT "AccessGrant_creator_fkey",
  ALTER COLUMN "createdByUserId" DROP NOT NULL,
  ADD COLUMN "creatorKind" "AccessGrantCreatorKind" NOT NULL DEFAULT 'USER',
  ADD COLUMN "createdBySystemKey" TEXT,
  ADD CONSTRAINT "AccessGrant_creator_shape" CHECK (
    ("creatorKind" = 'USER' AND "createdByUserId" IS NOT NULL AND "createdBySystemKey" IS NULL) OR
    ("creatorKind" = 'SYSTEM' AND "createdByUserId" IS NULL AND "createdBySystemKey" IS NOT NULL AND "createdBySystemKey" = 'legacy-role-backfill-v1')
  );

ALTER TABLE "AccessGrant"
  ADD CONSTRAINT "AccessGrant_creator_fkey"
  FOREIGN KEY ("organizationId", "createdByUserId")
  REFERENCES "MembershipAttribution"("organizationId", "userId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "guard_access_grant_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $guard_access_grant$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."subjectMembershipId" IS NULL THEN
      RAISE EXCEPTION 'AccessGrant requires an exact live membership'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW."id", NEW."organizationId", NEW."subjectUserId", NEW."capability",
    NEW."scopeType", NEW."locationId", NEW."screenGroupId", NEW."screenId",
    NEW."startsAt", NEW."expiresAt", NEW."creatorKind",
    NEW."createdByUserId", NEW."createdBySystemKey", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."organizationId", OLD."subjectUserId", OLD."capability",
    OLD."scopeType", OLD."locationId", OLD."screenGroupId", OLD."screenId",
    OLD."startsAt", OLD."expiresAt", OLD."creatorKind",
    OLD."createdByUserId", OLD."createdBySystemKey", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'AccessGrant authority fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."revokedAt" IS NOT NULL
    AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'AccessGrant revocation is irreversible'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."subjectMembershipId" IS DISTINCT FROM OLD."subjectMembershipId"
    AND NOT (
      OLD."subjectMembershipId" IS NOT NULL
      AND NEW."subjectMembershipId" IS NULL
      AND OLD."revokedAt" IS NOT NULL
      AND NEW."revokedAt" IS NOT DISTINCT FROM OLD."revokedAt"
    ) THEN
    RAISE EXCEPTION 'AccessGrant membership binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard_access_grant$;

CREATE TEMPORARY TABLE "_compatibility_role_capability" (
  "role" "OrgRole" NOT NULL,
  "capability" TEXT NOT NULL,
  PRIMARY KEY ("role", "capability")
) ON COMMIT DROP;

INSERT INTO "_compatibility_role_capability" ("role", "capability") VALUES
  ('OWNER', 'screen.read'),
  ('OWNER', 'location.read'),
  ('OWNER', 'media.read'),
  ('OWNER', 'playlist.read'),
  ('OWNER', 'schedule.read'),
  ('OWNER', 'release.candidate.read'),
  ('OWNER', 'release.candidate.create'),
  ('OWNER', 'release.candidate.submit'),
  ('OWNER', 'release.approve'),
  ('OWNER', 'release.publish'),
  ('OWNER', 'release.withdraw'),
  ('OWNER', 'screen.credential.revoke'),
  ('OWNER', 'screen.credential.reenroll'),
  ('ADMIN', 'screen.read'),
  ('ADMIN', 'location.read'),
  ('ADMIN', 'media.read'),
  ('ADMIN', 'playlist.read'),
  ('ADMIN', 'schedule.read'),
  ('ADMIN', 'release.candidate.read'),
  ('ADMIN', 'release.candidate.create'),
  ('ADMIN', 'release.candidate.submit'),
  ('ADMIN', 'release.approve'),
  ('ADMIN', 'release.publish'),
  ('ADMIN', 'release.withdraw'),
  ('ADMIN', 'screen.credential.revoke'),
  ('ADMIN', 'screen.credential.reenroll'),
  ('PUBLISHER', 'screen.read'),
  ('PUBLISHER', 'location.read'),
  ('PUBLISHER', 'media.read'),
  ('PUBLISHER', 'playlist.read'),
  ('PUBLISHER', 'schedule.read'),
  ('PUBLISHER', 'release.candidate.read'),
  ('PUBLISHER', 'release.candidate.create'),
  ('PUBLISHER', 'release.candidate.submit'),
  ('PUBLISHER', 'release.publish'),
  ('PUBLISHER', 'release.withdraw'),
  ('VIEWER', 'screen.read'),
  ('VIEWER', 'location.read'),
  ('VIEWER', 'media.read'),
  ('VIEWER', 'playlist.read'),
  ('VIEWER', 'schedule.read'),
  ('VIEWER', 'release.candidate.read');

-- An unexpected foundation grant needs operator reconciliation. Silently
-- adding a broad compatibility grant beside it would destroy useful shadow
-- evidence and could conceal a malformed import.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "AccessGrant" grant_row
    LEFT JOIN "Membership" membership
      ON membership."id" = grant_row."subjectMembershipId"
     AND membership."organizationId" = grant_row."organizationId"
     AND membership."userId" = grant_row."subjectUserId"
    LEFT JOIN "_compatibility_role_capability" bundle
      ON bundle."role" = membership."role"
     AND bundle."capability" = grant_row."capability"
    WHERE membership."id" IS NULL
       OR bundle."capability" IS NULL
       OR grant_row."id" <> 'compat-v1:' || encode(sha256(convert_to(
         'ScreenGoblin compatibility grant v1' || chr(10) ||
         octet_length(membership."organizationId")::text || ':' || membership."organizationId" ||
         octet_length(membership."id")::text || ':' || membership."id" ||
         membership."authorizationEpoch"::text || ':' ||
         octet_length(bundle."capability")::text || ':' || bundle."capability",
         'UTF8'
       )), 'hex')
       OR grant_row."creatorKind" <> 'SYSTEM'
       OR grant_row."createdByUserId" IS NOT NULL
       OR grant_row."createdBySystemKey" <> 'legacy-role-backfill-v1'
       OR grant_row."scopeType" <> 'ORGANIZATION'
       OR grant_row."locationId" IS NOT NULL
       OR grant_row."screenGroupId" IS NOT NULL
       OR grant_row."screenId" IS NOT NULL
       OR grant_row."startsAt" IS DISTINCT FROM grant_row."createdAt"
       OR grant_row."expiresAt" IS NOT NULL
       OR grant_row."revokedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Unexpected AccessGrant rows require compatibility-backfill reconciliation';
  END IF;
END
$preflight$;

INSERT INTO "AccessGrant" (
  "id", "organizationId", "subjectUserId", "subjectMembershipId",
  "capability", "scopeType", "startsAt", "creatorKind",
  "createdByUserId", "createdBySystemKey", "createdAt"
)
SELECT
  'compat-v1:' || encode(sha256(convert_to(
    'ScreenGoblin compatibility grant v1' || chr(10) ||
    octet_length(membership."organizationId")::text || ':' || membership."organizationId" ||
    octet_length(membership."id")::text || ':' || membership."id" ||
    membership."authorizationEpoch"::text || ':' ||
    octet_length(bundle."capability")::text || ':' || bundle."capability",
    'UTF8'
  )), 'hex'),
  membership."organizationId",
  membership."userId",
  membership."id",
  bundle."capability",
  'ORGANIZATION'::"AuthorizationScopeType",
  CURRENT_TIMESTAMP,
  'SYSTEM'::"AccessGrantCreatorKind",
  NULL,
  'legacy-role-backfill-v1',
  CURRENT_TIMESTAMP
FROM "Membership" membership
JOIN "_compatibility_role_capability" bundle ON bundle."role" = membership."role"
ON CONFLICT ("id") DO NOTHING;

DO $verify$
DECLARE expected_count BIGINT;
DECLARE actual_count BIGINT;
BEGIN
  SELECT count(*) INTO expected_count
  FROM "Membership" membership
  JOIN "_compatibility_role_capability" bundle ON bundle."role" = membership."role";

  SELECT count(*) INTO actual_count FROM "AccessGrant";
  IF actual_count <> expected_count OR EXISTS (
    SELECT 1
    FROM "Membership" membership
    JOIN "_compatibility_role_capability" bundle ON bundle."role" = membership."role"
    LEFT JOIN "AccessGrant" grant_row ON
      grant_row."id" = 'compat-v1:' || encode(sha256(convert_to(
        'ScreenGoblin compatibility grant v1' || chr(10) ||
        octet_length(membership."organizationId")::text || ':' || membership."organizationId" ||
        octet_length(membership."id")::text || ':' || membership."id" ||
        membership."authorizationEpoch"::text || ':' ||
        octet_length(bundle."capability")::text || ':' || bundle."capability",
        'UTF8'
      )), 'hex')
      AND grant_row."organizationId" = membership."organizationId"
      AND grant_row."subjectUserId" = membership."userId"
      AND grant_row."subjectMembershipId" = membership."id"
      AND grant_row."capability" = bundle."capability"
      AND grant_row."scopeType" = 'ORGANIZATION'
      AND grant_row."creatorKind" = 'SYSTEM'
      AND grant_row."createdByUserId" IS NULL
      AND grant_row."createdBySystemKey" = 'legacy-role-backfill-v1'
      AND grant_row."startsAt" = grant_row."createdAt"
      AND grant_row."expiresAt" IS NULL
      AND grant_row."revokedAt" IS NULL
    WHERE grant_row."id" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Compatibility AccessGrant backfill verification failed';
  END IF;
END
$verify$;

COMMIT;
