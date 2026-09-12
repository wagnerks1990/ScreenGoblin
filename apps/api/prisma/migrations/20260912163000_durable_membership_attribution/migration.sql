-- Release history must retain tenant-scoped creator attribution after an
-- operator removes the creator's live Membership. Tombstones are populated
-- from every existing membership and maintained for future memberships by a
-- same-transaction trigger.
BEGIN;

CREATE TABLE "MembershipAttribution" (
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MembershipAttribution_pkey" PRIMARY KEY ("organizationId", "userId")
);

CREATE INDEX "MembershipAttribution_userId_idx"
  ON "MembershipAttribution"("userId");

ALTER TABLE "MembershipAttribution"
  ADD CONSTRAINT "MembershipAttribution_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Close the backfill-to-trigger race. Membership writers remain blocked until
-- this transaction has both copied every existing principal and installed the
-- future-insert trigger.
LOCK TABLE "Membership" IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO "MembershipAttribution" ("organizationId", "userId")
SELECT "organizationId", "userId"
FROM "Membership"
ON CONFLICT ("organizationId", "userId") DO NOTHING;

CREATE FUNCTION "record_membership_attribution"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $membership_attribution$
BEGIN
  INSERT INTO public."MembershipAttribution" ("organizationId", "userId")
  VALUES (NEW."organizationId", NEW."userId")
  ON CONFLICT ("organizationId", "userId") DO NOTHING;
  RETURN NEW;
END
$membership_attribution$;

CREATE TRIGGER "Membership_record_attribution"
AFTER INSERT OR UPDATE OF "organizationId", "userId" ON "Membership"
FOR EACH ROW EXECUTE FUNCTION "record_membership_attribution"();

CREATE FUNCTION "reject_membership_attribution_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $membership_attribution_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public."Membership"
      WHERE "organizationId" = NEW."organizationId"
        AND "userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'MembershipAttribution requires a live tenant membership';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'MembershipAttribution rows cannot be updated';
  END IF;

  -- Preserve Organization ON DELETE CASCADE while rejecting direct tombstone
  -- deletion for a live tenant.
  IF EXISTS (
    SELECT 1 FROM public."Organization" WHERE "id" = OLD."organizationId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'MembershipAttribution rows cannot be deleted directly';
  END IF;

  RETURN OLD;
END
$membership_attribution_guard$;

CREATE TRIGGER "MembershipAttribution_reject_mutation"
BEFORE INSERT OR UPDATE OR DELETE ON "MembershipAttribution"
FOR EACH ROW EXECUTE FUNCTION "reject_membership_attribution_mutation"();

ALTER TABLE "PublishedRelease"
  DROP CONSTRAINT "PublishedRelease_creator_membership_fkey",
  ADD CONSTRAINT "PublishedRelease_creator_attribution_fkey"
    FOREIGN KEY ("organizationId", "createdById")
    REFERENCES "MembershipAttribution"("organizationId", "userId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReleaseAssignment"
  DROP CONSTRAINT "ReleaseAssignment_creator_membership_fkey",
  ADD CONSTRAINT "ReleaseAssignment_creator_attribution_fkey"
    FOREIGN KEY ("organizationId", "createdById")
    REFERENCES "MembershipAttribution"("organizationId", "userId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
