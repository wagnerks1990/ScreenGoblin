BEGIN;

CREATE TYPE "AuthorizationMode" AS ENUM ('LEGACY', 'SHADOW', 'SCOPED');
CREATE TYPE "AuthorizationScopeType" AS ENUM
  ('ORGANIZATION', 'LOCATION', 'SCREEN_GROUP', 'SCREEN');

ALTER TABLE "Organization"
  ADD COLUMN "authorizationMode" "AuthorizationMode" NOT NULL DEFAULT 'LEGACY',
  ADD CONSTRAINT "Organization_authorizationMode_foundation" CHECK (
    "authorizationMode" = 'LEGACY'::"AuthorizationMode"
  );

COMMENT ON CONSTRAINT "Organization_authorizationMode_foundation" ON "Organization" IS
  'Foundation release safety latch: a later reviewed enforcement migration must replace this LEGACY-only constraint.';

CREATE TABLE "ScreenGroup" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScreenGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScreenGroup_name" CHECK (
    "name" = BTRIM("name") AND CHAR_LENGTH("name") BETWEEN 1 AND 120
  ),
  CONSTRAINT "ScreenGroup_version" CHECK ("version" >= 0),
  CONSTRAINT "ScreenGroup_deletedAt" CHECK (
    "deletedAt" IS NULL OR "deletedAt" >= "createdAt"
  )
);

CREATE UNIQUE INDEX "ScreenGroup_id_organizationId_key"
  ON "ScreenGroup"("id", "organizationId");
CREATE UNIQUE INDEX "ScreenGroup_active_name_key"
  ON "ScreenGroup"("organizationId", LOWER("name"))
  WHERE "deletedAt" IS NULL;
CREATE INDEX "ScreenGroup_organizationId_deletedAt_name_idx"
  ON "ScreenGroup"("organizationId", "deletedAt", "name");

CREATE TABLE "ScreenGroupMember" (
  "organizationId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "screenId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScreenGroupMember_pkey" PRIMARY KEY ("groupId", "screenId")
);

CREATE INDEX "ScreenGroupMember_organizationId_screenId_idx"
  ON "ScreenGroupMember"("organizationId", "screenId");

CREATE TABLE "AccessGrant" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "subjectUserId" TEXT NOT NULL,
  "subjectMembershipId" TEXT,
  "capability" TEXT NOT NULL,
  "scopeType" "AuthorizationScopeType" NOT NULL,
  "locationId" TEXT,
  "screenGroupId" TEXT,
  "screenId" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccessGrant_capability" CHECK (
    "capability" IN (
      'screen.read',
      'location.read',
      'media.read',
      'playlist.read',
      'schedule.read',
      'release.candidate.read',
      'release.candidate.create',
      'release.candidate.submit',
      'release.approve',
      'release.publish',
      'release.withdraw',
      'screen.credential.revoke',
      'screen.credential.reenroll'
    )
  ),
  CONSTRAINT "AccessGrant_scope_shape" CHECK (
    ("scopeType" = 'ORGANIZATION' AND "locationId" IS NULL AND "screenGroupId" IS NULL AND "screenId" IS NULL) OR
    ("scopeType" = 'LOCATION' AND "locationId" IS NOT NULL AND "screenGroupId" IS NULL AND "screenId" IS NULL) OR
    ("scopeType" = 'SCREEN_GROUP' AND "locationId" IS NULL AND "screenGroupId" IS NOT NULL AND "screenId" IS NULL) OR
    ("scopeType" = 'SCREEN' AND "locationId" IS NULL AND "screenGroupId" IS NULL AND "screenId" IS NOT NULL)
  ),
  CONSTRAINT "AccessGrant_organization_only_capability" CHECK (
    "capability" NOT IN ('location.read', 'media.read', 'playlist.read') OR
    "scopeType" = 'ORGANIZATION'::"AuthorizationScopeType"
  ),
  CONSTRAINT "AccessGrant_window" CHECK (
    "expiresAt" IS NULL OR "expiresAt" > "startsAt"
  ),
  CONSTRAINT "AccessGrant_revocation" CHECK (
    "revokedAt" IS NULL OR "revokedAt" >= "createdAt"
  ),
  CONSTRAINT "AccessGrant_live_binding" CHECK (
    "subjectMembershipId" IS NOT NULL OR "revokedAt" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "Membership_id_organizationId_userId_key"
  ON "Membership"("id", "organizationId", "userId");

CREATE UNIQUE INDEX "AccessGrant_id_organizationId_key"
  ON "AccessGrant"("id", "organizationId");
CREATE UNIQUE INDEX "AccessGrant_active_scope_key"
  ON "AccessGrant"(
    "organizationId",
    "subjectUserId",
    "capability",
    "scopeType",
    COALESCE("locationId", ''),
    COALESCE("screenGroupId", ''),
    COALESCE("screenId", '')
  ) WHERE "revokedAt" IS NULL AND "subjectMembershipId" IS NOT NULL;
CREATE INDEX "AccessGrant_active_subject_capability_idx"
  ON "AccessGrant"(
    "organizationId", "subjectUserId", "capability", "revokedAt", "startsAt", "expiresAt"
  );
CREATE INDEX "AccessGrant_organizationId_locationId_idx"
  ON "AccessGrant"("organizationId", "locationId");
CREATE INDEX "AccessGrant_organizationId_screenGroupId_idx"
  ON "AccessGrant"("organizationId", "screenGroupId");
CREATE INDEX "AccessGrant_organizationId_screenId_idx"
  ON "AccessGrant"("organizationId", "screenId");

CREATE FUNCTION "guard_access_grant_lifecycle"()
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
    NEW."startsAt", NEW."expiresAt", NEW."createdByUserId", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."organizationId", OLD."subjectUserId", OLD."capability",
    OLD."scopeType", OLD."locationId", OLD."screenGroupId", OLD."screenId",
    OLD."startsAt", OLD."expiresAt", OLD."createdByUserId", OLD."createdAt"
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

CREATE TRIGGER "AccessGrant_guard_lifecycle"
BEFORE INSERT OR UPDATE ON "AccessGrant"
FOR EACH ROW EXECUTE FUNCTION "guard_access_grant_lifecycle"();

ALTER TABLE "ScreenGroup"
  ADD CONSTRAINT "ScreenGroup_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScreenGroupMember"
  ADD CONSTRAINT "ScreenGroupMember_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ScreenGroupMember_group_fkey"
  FOREIGN KEY ("groupId", "organizationId")
  REFERENCES "ScreenGroup"("id", "organizationId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ScreenGroupMember_screen_fkey"
  FOREIGN KEY ("screenId", "organizationId")
  REFERENCES "Screen"("id", "organizationId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "AccessGrant"
  ADD CONSTRAINT "AccessGrant_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AccessGrant_subject_fkey"
  FOREIGN KEY ("organizationId", "subjectUserId")
  REFERENCES "MembershipAttribution"("organizationId", "userId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "AccessGrant_subject_membership_fkey"
  FOREIGN KEY ("subjectMembershipId", "organizationId", "subjectUserId")
  REFERENCES "Membership"("id", "organizationId", "userId")
  ON DELETE SET NULL ("subjectMembershipId") ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "AccessGrant_creator_fkey"
  FOREIGN KEY ("organizationId", "createdByUserId")
  REFERENCES "MembershipAttribution"("organizationId", "userId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "AccessGrant_location_fkey"
  FOREIGN KEY ("locationId", "organizationId")
  REFERENCES "Location"("id", "organizationId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "AccessGrant_screenGroup_fkey"
  FOREIGN KEY ("screenGroupId", "organizationId")
  REFERENCES "ScreenGroup"("id", "organizationId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "AccessGrant_screen_fkey"
  FOREIGN KEY ("screenId", "organizationId")
  REFERENCES "Screen"("id", "organizationId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION "revoke_access_grants_for_removed_membership"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $revoke_access_grants$
BEGIN
  UPDATE public."AccessGrant"
  SET "revokedAt" = GREATEST(CURRENT_TIMESTAMP, "createdAt")
  WHERE "subjectMembershipId" = OLD."id"
    AND "organizationId" = OLD."organizationId"
    AND "subjectUserId" = OLD."userId"
    AND "revokedAt" IS NULL;
  RETURN OLD;
END
$revoke_access_grants$;

CREATE TRIGGER "Membership_revoke_access_grants"
BEFORE DELETE ON "Membership"
FOR EACH ROW EXECUTE FUNCTION "revoke_access_grants_for_removed_membership"();

COMMIT;
