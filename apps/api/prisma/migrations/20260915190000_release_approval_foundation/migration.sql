BEGIN;

ALTER TYPE "IdempotencyOperation" ADD VALUE IF NOT EXISTS 'RELEASE_CANDIDATE_CREATE';
ALTER TYPE "IdempotencyOperation" ADD VALUE IF NOT EXISTS 'RELEASE_CANDIDATE_SUBMIT';
ALTER TYPE "IdempotencyOperation" ADD VALUE IF NOT EXISTS 'RELEASE_CANDIDATE_APPROVE';
ALTER TYPE "IdempotencyOperation" ADD VALUE IF NOT EXISTS 'RELEASE_CANDIDATE_PUBLISH';

CREATE TYPE "ReleaseCandidateState" AS ENUM
  ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED');

ALTER TABLE "IdempotencyRecord"
  DROP CONSTRAINT "IdempotencyRecord_statusCode",
  ADD CONSTRAINT "IdempotencyRecord_statusCode" CHECK (
    ("operation"::text IN ('SCHEDULE_PUBLISH','SCREEN_ENROLLMENT_CREATE','RELEASE_CANDIDATE_CREATE') AND "statusCode"=201) OR
    ("operation"::text IN ('SCREEN_ENROLLMENT_ACTIVATE','RELEASE_CANDIDATE_SUBMIT','RELEASE_CANDIDATE_APPROVE','RELEASE_CANDIDATE_PUBLISH') AND "statusCode"=200)
  );

ALTER TABLE "ReleaseAssignment"
  ADD COLUMN "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "candidatePublicationId" TEXT,
  ADD COLUMN "expectedWithdrawalDigestSha256" TEXT;
UPDATE "ReleaseAssignment" SET "approvalRequired" = false;

CREATE TABLE "ReleaseCandidate" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "state" "ReleaseCandidateState" NOT NULL DEFAULT 'DRAFT',
  "digestSha256" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL,
  "scheduleName" TEXT NOT NULL,
  "priority" "SchedulePriority" NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3),
  "timezone" TEXT NOT NULL,
  "daysOfWeek" INTEGER[] NOT NULL,
  "dailyStartMinutes" INTEGER,
  "dailyEndMinutes" INTEGER,
  "enabled" BOOLEAN NOT NULL,
  "policyVersion" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "publicationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReleaseCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReleaseCandidate_digest_format" CHECK ("digestSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ReleaseCandidate_policy" CHECK ("policyVersion" = 1),
  CONSTRAINT "ReleaseCandidate_expiry" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '7 days'),
  CONSTRAINT "ReleaseCandidate_window" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt"),
  CONSTRAINT "ReleaseCandidate_priority" CHECK ("priority" <> 'EMERGENCY'::"SchedulePriority"),
  CONSTRAINT "ReleaseCandidate_days" CHECK ("daysOfWeek" <@ ARRAY[0,1,2,3,4,5,6]),
  CONSTRAINT "ReleaseCandidate_daily" CHECK (
    ("dailyStartMinutes" IS NULL OR "dailyStartMinutes" BETWEEN 0 AND 1439) AND
    ("dailyEndMinutes" IS NULL OR "dailyEndMinutes" BETWEEN 1 AND 1440) AND
    ("dailyStartMinutes" IS NULL OR "dailyEndMinutes" IS NULL OR "dailyEndMinutes" > "dailyStartMinutes")
  ),
  CONSTRAINT "ReleaseCandidate_state_timestamps" CHECK (
    ("state" = 'DRAFT' AND "submittedAt" IS NULL AND "approvedAt" IS NULL AND "publishedAt" IS NULL) OR
    ("state" = 'IN_REVIEW' AND "submittedAt" >= "createdAt" AND "submittedAt" < "expiresAt" AND "approvedAt" IS NULL AND "publishedAt" IS NULL) OR
    ("state" = 'APPROVED' AND "submittedAt" >= "createdAt" AND "approvedAt" >= "submittedAt" AND "approvedAt" < "expiresAt" AND "publishedAt" IS NULL) OR
    ("state" = 'PUBLISHED' AND "submittedAt" >= "createdAt" AND "approvedAt" >= "submittedAt" AND "publishedAt" >= "approvedAt" AND "publishedAt" < "expiresAt")
  ),
  CONSTRAINT "ReleaseCandidate_publication_state" CHECK (("state" = 'PUBLISHED') = ("publicationId" IS NOT NULL))
);

CREATE UNIQUE INDEX "ReleaseCandidate_id_organizationId_key"
  ON "ReleaseCandidate"("id", "organizationId");
CREATE UNIQUE INDEX "ReleaseCandidate_publicationId_key"
  ON "ReleaseCandidate"("publicationId");
CREATE UNIQUE INDEX "ReleaseCandidate_publicationId_id_organizationId_key"
  ON "ReleaseCandidate"("publicationId", "id", "organizationId");
CREATE INDEX "ReleaseCandidate_organizationId_digestSha256_idx"
  ON "ReleaseCandidate"("organizationId", "digestSha256");
CREATE INDEX "ReleaseCandidate_organizationId_state_expiresAt_idx"
  ON "ReleaseCandidate"("organizationId", "state", "expiresAt");

CREATE TABLE "ReleaseCandidateTarget" (
  "organizationId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "screenId" TEXT NOT NULL,
  "liveScreenId" TEXT,
  "liveScreenOrganizationId" TEXT,
  CONSTRAINT "ReleaseCandidateTarget_pkey" PRIMARY KEY ("candidateId", "screenId"),
  CONSTRAINT "ReleaseCandidateTarget_live_pair" CHECK (
    ("liveScreenId" IS NULL) = ("liveScreenOrganizationId" IS NULL)
  ),
  CONSTRAINT "ReleaseCandidateTarget_live_tenant" CHECK (
    "liveScreenOrganizationId" IS NULL OR "liveScreenOrganizationId" = "organizationId"
  ),
  CONSTRAINT "ReleaseCandidateTarget_live_screen" CHECK (
    "liveScreenId" IS NULL OR "liveScreenId" = "screenId"
  )
);
CREATE INDEX "ReleaseCandidateTarget_organizationId_screenId_idx"
  ON "ReleaseCandidateTarget"("organizationId", "screenId");

CREATE TABLE "ReleaseApproval" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "candidateDigestSha256" TEXT NOT NULL,
  "approverUserId" TEXT NOT NULL,
  "authenticationEpoch" INTEGER NOT NULL,
  "authorizationEpoch" INTEGER NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReleaseApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReleaseApproval_digest_format" CHECK ("candidateDigestSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ReleaseApproval_epochs" CHECK ("authenticationEpoch" >= 0 AND "authorizationEpoch" >= 0)
);
CREATE UNIQUE INDEX "ReleaseApproval_id_organizationId_key"
  ON "ReleaseApproval"("id", "organizationId");
CREATE UNIQUE INDEX "ReleaseApproval_candidateId_organizationId_key"
  ON "ReleaseApproval"("candidateId", "organizationId");
CREATE INDEX "ReleaseApproval_organizationId_approverUserId_idx"
  ON "ReleaseApproval"("organizationId", "approverUserId");

CREATE TABLE "ReleaseCandidatePublication" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "publisherUserId" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReleaseCandidatePublication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReleaseCandidatePublication_id_organizationId_key"
  ON "ReleaseCandidatePublication"("id", "organizationId");
CREATE UNIQUE INDEX "ReleaseCandidatePublication_candidateId_organizationId_key"
  ON "ReleaseCandidatePublication"("candidateId", "organizationId");
CREATE UNIQUE INDEX "ReleaseCandidatePublication_scheduleId_organizationId_key"
  ON "ReleaseCandidatePublication"("scheduleId", "organizationId");
CREATE UNIQUE INDEX "ReleaseCandidatePublication_assignmentId_organizationId_key"
  ON "ReleaseCandidatePublication"("assignmentId", "organizationId");
CREATE UNIQUE INDEX "ReleaseCandidatePublication_id_candidateId_organizationId_key"
  ON "ReleaseCandidatePublication"("id", "candidateId", "organizationId");
CREATE UNIQUE INDEX "ReleaseCandidatePublication_id_assignmentId_organizationId_key"
  ON "ReleaseCandidatePublication"("id", "assignmentId", "organizationId");
CREATE INDEX "ReleaseCandidatePublication_organizationId_publishedAt_idx"
  ON "ReleaseCandidatePublication"("organizationId", "publishedAt");

CREATE UNIQUE INDEX "ReleaseAssignment_candidatePublicationId_key"
  ON "ReleaseAssignment"("candidatePublicationId");
CREATE UNIQUE INDEX "ReleaseAssignment_candidatePublicationId_id_organizationId_key"
  ON "ReleaseAssignment"("candidatePublicationId", "id", "organizationId");
ALTER TABLE "ReleaseAssignment"
  ADD CONSTRAINT "ReleaseAssignment_candidate_publication_state" CHECK (
    ("state" = 'ASSIGNED' AND "approvalRequired") = ("candidatePublicationId" IS NOT NULL)
  ),
  ADD CONSTRAINT "ReleaseAssignment_expected_withdrawal_digest" CHECK (
    (("state" = 'ASSIGNED' AND "approvalRequired") = ("expectedWithdrawalDigestSha256" IS NOT NULL)) AND
    ("expectedWithdrawalDigestSha256" IS NULL OR "expectedWithdrawalDigestSha256" ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE "ReleaseCandidate"
  ADD CONSTRAINT "ReleaseCandidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReleaseCandidate_release_fkey" FOREIGN KEY ("releaseId", "organizationId") REFERENCES "PublishedRelease"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ReleaseCandidate_author_fkey" FOREIGN KEY ("organizationId", "authorUserId") REFERENCES "MembershipAttribution"("organizationId", "userId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ReleaseCandidateTarget"
  ADD CONSTRAINT "ReleaseCandidateTarget_candidate_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "ReleaseCandidate"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReleaseCandidateTarget_liveScreen_fkey" FOREIGN KEY ("liveScreenId", "liveScreenOrganizationId") REFERENCES "Screen"("id", "organizationId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReleaseApproval"
  ADD CONSTRAINT "ReleaseApproval_candidate_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "ReleaseCandidate"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReleaseApproval_approver_fkey" FOREIGN KEY ("organizationId", "approverUserId") REFERENCES "MembershipAttribution"("organizationId", "userId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ReleaseCandidatePublication"
  ADD CONSTRAINT "ReleaseCandidatePublication_candidate_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "ReleaseCandidate"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReleaseCandidatePublication_schedule_fkey" FOREIGN KEY ("scheduleId", "organizationId") REFERENCES "Schedule"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ReleaseCandidatePublication_assignment_fkey" FOREIGN KEY ("assignmentId", "organizationId") REFERENCES "ReleaseAssignment"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ReleaseCandidatePublication_publisher_fkey" FOREIGN KEY ("organizationId", "publisherUserId") REFERENCES "MembershipAttribution"("organizationId", "userId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ReleaseCandidate"
  ADD CONSTRAINT "ReleaseCandidate_final_publication_fkey"
  FOREIGN KEY ("publicationId", "id", "organizationId")
  REFERENCES "ReleaseCandidatePublication"("id", "candidateId", "organizationId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ReleaseAssignment"
  ADD CONSTRAINT "ReleaseAssignment_final_publication_fkey"
  FOREIGN KEY ("candidatePublicationId", "id", "organizationId")
  REFERENCES "ReleaseCandidatePublication"("id", "assignmentId", "organizationId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Tenant deletion cascades reach this immutable graph through several parents
-- in an order PostgreSQL does not guarantee. Deferred NO ACTION continues to
-- reject an ordinary parent deletion at commit, while allowing the complete
-- organization cascade to remove every same-tenant row atomically.
ALTER TABLE "PlaylistItem"
  DROP CONSTRAINT "PlaylistItem_assetId_organizationId_fkey",
  ADD CONSTRAINT "PlaylistItem_assetId_organizationId_fkey"
    FOREIGN KEY ("assetId", "organizationId") REFERENCES "MediaAsset"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PublishedRelease"
  DROP CONSTRAINT "PublishedRelease_sourcePlaylistId_organizationId_fkey",
  DROP CONSTRAINT "PublishedRelease_creator_attribution_fkey",
  ADD CONSTRAINT "PublishedRelease_sourcePlaylistId_organizationId_fkey"
    FOREIGN KEY ("sourcePlaylistId", "organizationId") REFERENCES "Playlist"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "PublishedRelease_creator_attribution_fkey"
    FOREIGN KEY ("organizationId", "createdById") REFERENCES "MembershipAttribution"("organizationId", "userId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "FrozenReleaseItem"
  DROP CONSTRAINT "FrozenReleaseItem_sourcePlaylistItemId_organizationId_fkey",
  DROP CONSTRAINT "FrozenReleaseItem_sourceAssetId_organizationId_fkey",
  ADD CONSTRAINT "FrozenReleaseItem_sourcePlaylistItemId_organizationId_fkey"
    FOREIGN KEY ("sourcePlaylistItemId", "organizationId") REFERENCES "PlaylistItem"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "FrozenReleaseItem_sourceAssetId_organizationId_fkey"
    FOREIGN KEY ("sourceAssetId", "organizationId") REFERENCES "MediaAsset"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ReleaseAssignment"
  DROP CONSTRAINT "ReleaseAssignment_releaseId_organizationId_fkey",
  DROP CONSTRAINT "ReleaseAssignment_scheduleId_organizationId_fkey",
  DROP CONSTRAINT "ReleaseAssignment_creator_attribution_fkey",
  DROP CONSTRAINT "ReleaseAssignment_previousAssignmentId_organizationId_fkey",
  ADD CONSTRAINT "ReleaseAssignment_releaseId_organizationId_fkey"
    FOREIGN KEY ("releaseId", "organizationId") REFERENCES "PublishedRelease"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ReleaseAssignment_scheduleId_organizationId_fkey"
    FOREIGN KEY ("scheduleId", "organizationId") REFERENCES "Schedule"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ReleaseAssignment_creator_attribution_fkey"
    FOREIGN KEY ("organizationId", "createdById") REFERENCES "MembershipAttribution"("organizationId", "userId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ReleaseAssignment_previousAssignmentId_organizationId_fkey"
    FOREIGN KEY ("previousAssignmentId", "organizationId") REFERENCES "ReleaseAssignment"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "Screen"
  DROP CONSTRAINT "Screen_locationId_organizationId_fkey",
  ADD CONSTRAINT "Screen_locationId_organizationId_fkey"
    FOREIGN KEY ("locationId", "organizationId") REFERENCES "Location"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PairingAttempt"
  DROP CONSTRAINT "PairingAttempt_boundCredentialId_organizationId_fkey",
  ADD CONSTRAINT "PairingAttempt_boundCredentialId_organizationId_fkey"
    FOREIGN KEY ("boundCredentialId", "organizationId") REFERENCES "DeviceCredential"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION "guard_release_candidate_history"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public."Organization" WHERE "id" = OLD."organizationId") THEN
      IF NOT (COALESCE(current_setting('screengoblin.candidate_gc_id', true),'')=OLD."id" AND OLD."state" IN ('DRAFT','IN_REVIEW','APPROVED') AND OLD."expiresAt" <= CURRENT_TIMESTAMP AND OLD."publishedAt" IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ReleaseCandidate history cannot be deleted';
      END IF;
      -- Delete while the parent remains visible so the target guard can prove
      -- this is the exact, expired candidate selected by the bounded GC.
      DELETE FROM public."ReleaseCandidateTarget"
        WHERE "candidateId"=OLD."id" AND "organizationId"=OLD."organizationId";
      DELETE FROM public."ReleaseApproval"
        WHERE "candidateId"=OLD."id" AND "organizationId"=OLD."organizationId";
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW."organizationId",NEW."releaseId",NEW."digestSha256",NEW."authorUserId",NEW."scheduleName",NEW."priority",NEW."startsAt",NEW."endsAt",NEW."timezone",NEW."daysOfWeek",NEW."dailyStartMinutes",NEW."dailyEndMinutes",NEW."enabled",NEW."policyVersion",NEW."expiresAt",NEW."createdAt")
     IS DISTINCT FROM
     ROW(OLD."organizationId",OLD."releaseId",OLD."digestSha256",OLD."authorUserId",OLD."scheduleName",OLD."priority",OLD."startsAt",OLD."endsAt",OLD."timezone",OLD."daysOfWeek",OLD."dailyStartMinutes",OLD."dailyEndMinutes",OLD."enabled",OLD."policyVersion",OLD."expiresAt",OLD."createdAt") THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ReleaseCandidate snapshot is immutable';
  END IF;
  IF NOT (
    (OLD."state"='DRAFT' AND NEW."state"='IN_REVIEW' AND OLD."publicationId" IS NULL AND NEW."publicationId" IS NULL AND OLD."submittedAt" IS NULL AND NEW."submittedAt" IS NOT NULL AND NEW."approvedAt" IS NULL AND NEW."publishedAt" IS NULL) OR
    (OLD."state"='IN_REVIEW' AND NEW."state"='APPROVED' AND OLD."publicationId" IS NULL AND NEW."publicationId" IS NULL AND NEW."submittedAt"=OLD."submittedAt" AND NEW."approvedAt" IS NOT NULL AND NEW."publishedAt" IS NULL) OR
    (OLD."state"='APPROVED' AND NEW."state"='PUBLISHED' AND OLD."publicationId" IS NULL AND NEW."publicationId" IS NOT NULL AND NEW."submittedAt"=OLD."submittedAt" AND NEW."approvedAt"=OLD."approvedAt" AND NEW."publishedAt" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Invalid ReleaseCandidate transition';
  END IF;
  IF NEW."state"='APPROVED' AND NOT EXISTS (
    SELECT 1 FROM public."ReleaseApproval"
    WHERE "candidateId"=NEW."id" AND "organizationId"=NEW."organizationId"
      AND "candidateDigestSha256"=NEW."digestSha256"
      AND "approvedAt"=NEW."approvedAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Approved state requires matching approval evidence';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER "ReleaseCandidate_guard_history"
  BEFORE UPDATE OR DELETE ON "ReleaseCandidate"
  FOR EACH ROW EXECUTE FUNCTION "guard_release_candidate_history"();

CREATE FUNCTION "guard_release_candidate_target"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public."ReleaseCandidate"
      WHERE "id"=NEW."candidateId" AND "organizationId"=NEW."organizationId" AND "state"='DRAFT'
    ) THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Targets may only be attached to a draft candidate';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM public."Organization" WHERE "id"=OLD."organizationId") AND
       NOT (
         COALESCE(current_setting('screengoblin.candidate_gc_id', true),'')=OLD."candidateId" AND
         EXISTS (SELECT 1 FROM public."ReleaseCandidate" WHERE "id"=OLD."candidateId" AND "organizationId"=OLD."organizationId" AND "state" IN ('DRAFT','IN_REVIEW','APPROVED') AND "expiresAt" <= CURRENT_TIMESTAMP AND "publishedAt" IS NULL)
       ) THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ReleaseCandidateTarget history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW."organizationId",NEW."candidateId",NEW."screenId") IS DISTINCT FROM ROW(OLD."organizationId",OLD."candidateId",OLD."screenId") OR
     NOT (NEW."liveScreenId" IS NULL AND NEW."liveScreenOrganizationId" IS NULL AND OLD."liveScreenId" IS NOT NULL AND OLD."liveScreenOrganizationId" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ReleaseCandidateTarget snapshot is immutable';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER "ReleaseCandidateTarget_guard_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseCandidateTarget"
  FOR EACH ROW EXECUTE FUNCTION "guard_release_candidate_target"();

CREATE FUNCTION "require_release_candidate_publication"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW."id",NEW."organizationId",NEW."releaseId",NEW."scheduleId",NEW."state",NEW."digestSha256",NEW."previousAssignmentId",NEW."createdById",NEW."scheduleName",NEW."priority",NEW."startsAt",NEW."endsAt",NEW."timezone",NEW."daysOfWeek",NEW."dailyStartMinutes",NEW."dailyEndMinutes",NEW."enabled",NEW."approvalRequired",NEW."candidatePublicationId",NEW."expectedWithdrawalDigestSha256",NEW."createdAt") IS DISTINCT FROM ROW(OLD."id",OLD."organizationId",OLD."releaseId",OLD."scheduleId",OLD."state",OLD."digestSha256",OLD."previousAssignmentId",OLD."createdById",OLD."scheduleName",OLD."priority",OLD."startsAt",OLD."endsAt",OLD."timezone",OLD."daysOfWeek",OLD."dailyStartMinutes",OLD."dailyEndMinutes",OLD."enabled",OLD."approvalRequired",OLD."candidatePublicationId",OLD."expectedWithdrawalDigestSha256",OLD."createdAt") THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Release assignment snapshot is immutable';
  END IF;
  IF TG_OP='INSERT' AND NEW."state"='ASSIGNED' AND (
    NOT NEW."approvalRequired" OR
    NEW."candidatePublicationId" IS NULL OR
    NEW."expectedWithdrawalDigestSha256" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='New assigned releases require complete approval provenance';
  END IF;
  IF TG_OP='INSERT' AND NEW."state"='WITHDRAWN' AND NOT EXISTS (
    SELECT 1 FROM public."ReleaseAssignment" previous
    WHERE previous."id"=NEW."previousAssignmentId"
      AND previous."organizationId"=NEW."organizationId"
      AND previous."state"='ASSIGNED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Withdrawal requires an assigned predecessor';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER "ReleaseAssignment_require_candidate"
  BEFORE INSERT OR UPDATE ON "ReleaseAssignment"
  FOR EACH ROW EXECUTE FUNCTION "require_release_candidate_publication"();

CREATE FUNCTION "guard_release_assignment_target"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE assignment_record public."ReleaseAssignment";
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO assignment_record FROM public."ReleaseAssignment"
      WHERE "id"=NEW."assignmentId" AND "organizationId"=NEW."organizationId";
    IF assignment_record."id" IS NULL OR NOT (
      (assignment_record."state"='ASSIGNED' AND assignment_record."approvalRequired" AND assignment_record."candidatePublicationId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public."ReleaseCandidatePublication"
        WHERE "id"=assignment_record."candidatePublicationId" AND "assignmentId"=assignment_record."id" AND "organizationId"=assignment_record."organizationId"
      )) OR
      (assignment_record."state"='WITHDRAWN' AND EXISTS (
        SELECT 1
        FROM public."ReleaseAssignment" previous
        INNER JOIN public."ReleaseAssignmentTarget" previous_target
          ON previous_target."assignmentId"=previous."id"
         AND previous_target."organizationId"=previous."organizationId"
        WHERE previous."id"=assignment_record."previousAssignmentId"
          AND previous."organizationId"=assignment_record."organizationId"
          AND previous."state"='ASSIGNED'
          AND previous_target."screenId"=NEW."screenId"
          AND previous_target."liveScreenId" IS NOT DISTINCT FROM NEW."liveScreenId"
          AND previous_target."liveScreenOrganizationId" IS NOT DISTINCT FROM NEW."liveScreenOrganizationId"
      ))
    ) THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Release assignment targets may only be attached during assignment creation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM public."Organization" WHERE "id"=OLD."organizationId") THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Release assignment target history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW."organizationId",NEW."assignmentId",NEW."screenId") IS DISTINCT FROM ROW(OLD."organizationId",OLD."assignmentId",OLD."screenId") OR
     NOT (NEW."liveScreenId" IS NULL AND NEW."liveScreenOrganizationId" IS NULL AND OLD."liveScreenId" IS NOT NULL AND OLD."liveScreenOrganizationId" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Release assignment target snapshot is immutable';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER "ReleaseAssignmentTarget_guard_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseAssignmentTarget"
  FOR EACH ROW EXECUTE FUNCTION "guard_release_assignment_target"();

CREATE FUNCTION "require_complete_release_withdrawal_targets"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE assignment_record public."ReleaseAssignment";
DECLARE previous_record public."ReleaseAssignment";
BEGIN
  SELECT * INTO assignment_record
  FROM public."ReleaseAssignment"
  WHERE "id"=NEW."id" AND "organizationId"=NEW."organizationId";
  IF assignment_record."id" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Release withdrawal history cannot disappear before commit';
  END IF;
  IF assignment_record."state" <> 'WITHDRAWN' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO previous_record
  FROM public."ReleaseAssignment"
  WHERE "id"=assignment_record."previousAssignmentId"
    AND "organizationId"=assignment_record."organizationId";
  IF previous_record."id" IS NULL OR previous_record."state" <> 'ASSIGNED' OR
     (previous_record."approvalRequired" AND assignment_record."digestSha256" IS DISTINCT FROM previous_record."expectedWithdrawalDigestSha256") OR
     ROW(assignment_record."organizationId",assignment_record."releaseId",assignment_record."scheduleId",assignment_record."scheduleName",assignment_record."priority",assignment_record."startsAt",assignment_record."endsAt",assignment_record."timezone",assignment_record."daysOfWeek",assignment_record."dailyStartMinutes",assignment_record."dailyEndMinutes",assignment_record."enabled") IS DISTINCT FROM
     ROW(previous_record."organizationId",previous_record."releaseId",previous_record."scheduleId",previous_record."scheduleName",previous_record."priority",previous_record."startsAt",previous_record."endsAt",previous_record."timezone",previous_record."daysOfWeek",previous_record."dailyStartMinutes",previous_record."dailyEndMinutes",previous_record."enabled") OR
     NOT EXISTS (
       SELECT 1 FROM public."ReleaseAssignmentTarget"
       WHERE "assignmentId"=assignment_record."id" AND "organizationId"=assignment_record."organizationId"
     ) OR EXISTS (
       (SELECT "screenId","liveScreenId","liveScreenOrganizationId"
        FROM public."ReleaseAssignmentTarget"
        WHERE "assignmentId"=assignment_record."previousAssignmentId" AND "organizationId"=assignment_record."organizationId"
        EXCEPT
        SELECT "screenId","liveScreenId","liveScreenOrganizationId"
        FROM public."ReleaseAssignmentTarget"
        WHERE "assignmentId"=assignment_record."id" AND "organizationId"=assignment_record."organizationId")
       UNION ALL
       (SELECT "screenId","liveScreenId","liveScreenOrganizationId"
        FROM public."ReleaseAssignmentTarget"
        WHERE "assignmentId"=assignment_record."id" AND "organizationId"=assignment_record."organizationId"
        EXCEPT
        SELECT "screenId","liveScreenId","liveScreenOrganizationId"
        FROM public."ReleaseAssignmentTarget"
        WHERE "assignmentId"=assignment_record."previousAssignmentId" AND "organizationId"=assignment_record."organizationId")
     ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Release withdrawal targets must exactly match the assigned predecessor';
  END IF;
  RETURN NULL;
END $guard$;
CREATE CONSTRAINT TRIGGER "ReleaseAssignment_withdrawal_targets_complete"
  AFTER INSERT ON "ReleaseAssignment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "require_complete_release_withdrawal_targets"();

CREATE FUNCTION "guard_release_assignment_approval_flag"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW."approvalRequired" IS DISTINCT FROM OLD."approvalRequired" THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Release assignment approval provenance is immutable';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER "ReleaseAssignment_guard_approval_flag"
  BEFORE UPDATE ON "ReleaseAssignment"
  FOR EACH ROW EXECUTE FUNCTION "guard_release_assignment_approval_flag"();

CREATE FUNCTION "guard_release_approval"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE candidate_record public."ReleaseCandidate";
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public."Organization" WHERE "id"=OLD."organizationId") OR (
      COALESCE(current_setting('screengoblin.candidate_gc_id', true),'')=OLD."candidateId" AND
      EXISTS (SELECT 1 FROM public."ReleaseCandidate" WHERE "id"=OLD."candidateId" AND "organizationId"=OLD."organizationId" AND "state"='APPROVED' AND "expiresAt" <= CURRENT_TIMESTAMP AND "publishedAt" IS NULL)
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ReleaseApproval evidence is append-only';
  END IF;
  SELECT * INTO candidate_record FROM public."ReleaseCandidate"
    WHERE "id"=NEW."candidateId" AND "organizationId"=NEW."organizationId" FOR UPDATE;
  IF candidate_record."id" IS NULL OR candidate_record."state" <> 'IN_REVIEW' OR
     candidate_record."digestSha256" <> NEW."candidateDigestSha256" OR
     candidate_record."authorUserId" = NEW."approverUserId" OR
     candidate_record."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ReleaseApproval does not match an approvable candidate';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER "ReleaseApproval_guard_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseApproval"
  FOR EACH ROW EXECUTE FUNCTION "guard_release_approval"();

CREATE FUNCTION "guard_release_candidate_publication"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE candidate_record public."ReleaseCandidate";
DECLARE approval_record public."ReleaseApproval";
DECLARE assignment_record public."ReleaseAssignment";
DECLARE schedule_record public."Schedule";
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM public."Organization" WHERE "id"=OLD."organizationId") THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ReleaseCandidatePublication evidence is append-only';
  END IF;
  SELECT * INTO candidate_record FROM public."ReleaseCandidate"
    WHERE "id"=NEW."candidateId" AND "organizationId"=NEW."organizationId" FOR UPDATE;
  SELECT * INTO approval_record FROM public."ReleaseApproval"
    WHERE "candidateId"=NEW."candidateId" AND "organizationId"=NEW."organizationId";
  SELECT * INTO assignment_record FROM public."ReleaseAssignment"
    WHERE "id"=NEW."assignmentId" AND "organizationId"=NEW."organizationId";
  SELECT * INTO schedule_record FROM public."Schedule"
    WHERE "id"=NEW."scheduleId" AND "organizationId"=NEW."organizationId";
  IF candidate_record."id" IS NULL OR candidate_record."state" <> 'PUBLISHED' OR
     candidate_record."publicationId" <> NEW."id" OR
     candidate_record."publishedAt" <> NEW."publishedAt" OR
     candidate_record."expiresAt" <= CURRENT_TIMESTAMP OR approval_record."id" IS NULL OR
     approval_record."candidateDigestSha256" <> candidate_record."digestSha256" OR
     assignment_record."id" IS NULL OR assignment_record."state" <> 'ASSIGNED' OR
     NOT assignment_record."approvalRequired" OR
     assignment_record."candidatePublicationId" <> NEW."id" OR
     assignment_record."releaseId" <> candidate_record."releaseId" OR
     assignment_record."scheduleId" <> NEW."scheduleId" OR
     schedule_record."id" IS NULL OR schedule_record."playlistId" <> (SELECT "sourcePlaylistId" FROM public."PublishedRelease" WHERE "id"=candidate_record."releaseId" AND "organizationId"=candidate_record."organizationId") OR
     ROW(assignment_record."scheduleName",assignment_record."priority",assignment_record."startsAt",assignment_record."endsAt",assignment_record."timezone",assignment_record."daysOfWeek",assignment_record."dailyStartMinutes",assignment_record."dailyEndMinutes",assignment_record."enabled") IS DISTINCT FROM
       ROW(candidate_record."scheduleName",candidate_record."priority",candidate_record."startsAt",candidate_record."endsAt",candidate_record."timezone",candidate_record."daysOfWeek",candidate_record."dailyStartMinutes",candidate_record."dailyEndMinutes",candidate_record."enabled") OR
     ROW(schedule_record."name",schedule_record."priority",schedule_record."startsAt",schedule_record."endsAt",schedule_record."timezone",schedule_record."daysOfWeek",schedule_record."dailyStartMinutes",schedule_record."dailyEndMinutes",schedule_record."enabled") IS DISTINCT FROM
       ROW(candidate_record."scheduleName",candidate_record."priority",candidate_record."startsAt",candidate_record."endsAt",candidate_record."timezone",candidate_record."daysOfWeek",candidate_record."dailyStartMinutes",candidate_record."dailyEndMinutes",candidate_record."enabled") OR
     NOT EXISTS (
       SELECT 1 FROM public."ReleaseCandidateTarget"
       WHERE "candidateId"=candidate_record."id" AND "organizationId"=candidate_record."organizationId"
     ) OR
     EXISTS (
       SELECT 1 FROM public."ReleaseCandidateTarget"
       WHERE "candidateId"=candidate_record."id" AND "organizationId"=candidate_record."organizationId"
         AND ("liveScreenId" IS NULL OR "liveScreenOrganizationId" IS NULL OR
              "liveScreenId" <> "screenId" OR "liveScreenOrganizationId" <> "organizationId")
     ) OR
     EXISTS (
       (SELECT "screenId","liveScreenId","liveScreenOrganizationId" FROM public."ReleaseCandidateTarget" WHERE "candidateId"=candidate_record."id" AND "organizationId"=candidate_record."organizationId"
        EXCEPT SELECT "screenId","liveScreenId","liveScreenOrganizationId" FROM public."ReleaseAssignmentTarget" WHERE "assignmentId"=assignment_record."id" AND "organizationId"=assignment_record."organizationId")
       UNION ALL
       (SELECT "screenId","liveScreenId","liveScreenOrganizationId" FROM public."ReleaseAssignmentTarget" WHERE "assignmentId"=assignment_record."id" AND "organizationId"=assignment_record."organizationId"
        EXCEPT SELECT "screenId","liveScreenId","liveScreenOrganizationId" FROM public."ReleaseCandidateTarget" WHERE "candidateId"=candidate_record."id" AND "organizationId"=candidate_record."organizationId")
     ) OR
     EXISTS (
       (SELECT "screenId" FROM public."ReleaseCandidateTarget" WHERE "candidateId"=candidate_record."id" AND "organizationId"=candidate_record."organizationId"
        EXCEPT SELECT "screenId" FROM public."ScheduleTarget" WHERE "scheduleId"=schedule_record."id" AND "organizationId"=schedule_record."organizationId")
       UNION ALL
       (SELECT "screenId" FROM public."ScheduleTarget" WHERE "scheduleId"=schedule_record."id" AND "organizationId"=schedule_record."organizationId"
        EXCEPT SELECT "screenId" FROM public."ReleaseCandidateTarget" WHERE "candidateId"=candidate_record."id" AND "organizationId"=candidate_record."organizationId")
     ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Publication does not match an approved candidate';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER "ReleaseCandidatePublication_guard_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseCandidatePublication"
  FOR EACH ROW EXECUTE FUNCTION "guard_release_candidate_publication"();

COMMIT;
