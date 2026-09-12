-- Add immutable ordinary-release snapshots and append-only assignment events.
-- Mutable playlist/media rows are referenced with RESTRICT so release history
-- and the assets required for playback cannot be silently cascaded away.
BEGIN;

-- This bounded migration cannot reproduce the application canonicalization
-- rules from legacy mutable schedules inside SQL. Refuse an unsafe upgrade
-- instead of silently switching existing screens to an empty release set.
-- Operators must publish/convert or remove legacy schedules in a rehearsed
-- maintenance window before applying this migration.
DO $release_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM "Schedule") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'immutable release preflight failed: legacy schedules require explicit conversion before migration';
  END IF;
END
$release_preflight$;

CREATE TYPE "ReleaseAssignmentState" AS ENUM ('ASSIGNED', 'WITHDRAWN');

CREATE TABLE "PublishedRelease" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourcePlaylistId" TEXT NOT NULL,
    "sourcePlaylistName" TEXT NOT NULL,
    "sourcePlaylistDescription" TEXT NOT NULL,
    "sourcePlaylistUpdatedAt" TIMESTAMP(3) NOT NULL,
    "digestSha256" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishedRelease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublishedRelease_digestSha256_check"
      CHECK ("digestSha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "FrozenReleaseItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "sourcePlaylistItemId" TEXT NOT NULL,
    "sourceAssetId" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "assetKind" "MediaKind" NOT NULL,
    "assetMimeType" TEXT NOT NULL,
    "assetUrl" TEXT NOT NULL,
    "assetChecksumSha256" TEXT NOT NULL,
    "assetSizeBytes" BIGINT NOT NULL,
    "assetCreatedAt" TIMESTAMP(3) NOT NULL,
    "assetExpiresAt" TIMESTAMP(3),
    "position" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrozenReleaseItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FrozenReleaseItem_checksum_check"
      CHECK ("assetChecksumSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "FrozenReleaseItem_position_check" CHECK ("position" >= 0),
    CONSTRAINT "FrozenReleaseItem_duration_check" CHECK ("durationSeconds" > 0),
    CONSTRAINT "FrozenReleaseItem_size_check" CHECK ("assetSizeBytes" >= 0)
);

CREATE TABLE "ReleaseAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "state" "ReleaseAssignmentState" NOT NULL,
    "digestSha256" TEXT NOT NULL,
    "previousAssignmentId" TEXT,
    "createdById" TEXT NOT NULL,
    "scheduleName" TEXT NOT NULL,
    "priority" "SchedulePriority" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL,
    "daysOfWeek" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "dailyStartMinutes" INTEGER,
    "dailyEndMinutes" INTEGER,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReleaseAssignment_digestSha256_check"
      CHECK ("digestSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ReleaseAssignment_history_state_check"
      CHECK ("state" <> 'WITHDRAWN' OR "previousAssignmentId" IS NOT NULL)
);

CREATE TABLE "ReleaseAssignmentTarget" (
    "organizationId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "screenId" TEXT NOT NULL,
    "liveScreenId" TEXT,
    "liveScreenOrganizationId" TEXT,

    CONSTRAINT "ReleaseAssignmentTarget_pkey"
      PRIMARY KEY ("assignmentId", "screenId"),
    CONSTRAINT "ReleaseAssignmentTarget_live_screen_check"
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

CREATE UNIQUE INDEX "PublishedRelease_id_organizationId_key"
  ON "PublishedRelease"("id", "organizationId");
CREATE UNIQUE INDEX "PublishedRelease_organizationId_digestSha256_key"
  ON "PublishedRelease"("organizationId", "digestSha256");
CREATE INDEX "PublishedRelease_organizationId_createdAt_idx"
  ON "PublishedRelease"("organizationId", "createdAt");

CREATE UNIQUE INDEX "FrozenReleaseItem_releaseId_position_key"
  ON "FrozenReleaseItem"("releaseId", "position");
CREATE UNIQUE INDEX "PlaylistItem_id_organizationId_key"
  ON "PlaylistItem"("id", "organizationId");
CREATE INDEX "FrozenReleaseItem_organizationId_sourceAssetId_idx"
  ON "FrozenReleaseItem"("organizationId", "sourceAssetId");

CREATE UNIQUE INDEX "ReleaseAssignment_previousAssignmentId_key"
  ON "ReleaseAssignment"("previousAssignmentId");
CREATE UNIQUE INDEX "ReleaseAssignment_id_organizationId_key"
  ON "ReleaseAssignment"("id", "organizationId");
CREATE INDEX "ReleaseAssignment_organizationId_scheduleId_createdAt_idx"
  ON "ReleaseAssignment"("organizationId", "scheduleId", "createdAt");
CREATE INDEX "ReleaseAssignment_organizationId_releaseId_idx"
  ON "ReleaseAssignment"("organizationId", "releaseId");
CREATE INDEX "ReleaseAssignmentTarget_organizationId_screenId_idx"
  ON "ReleaseAssignmentTarget"("organizationId", "screenId");

ALTER TABLE "PublishedRelease" ADD CONSTRAINT "PublishedRelease_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishedRelease" ADD CONSTRAINT "PublishedRelease_sourcePlaylistId_organizationId_fkey"
  FOREIGN KEY ("sourcePlaylistId", "organizationId")
  REFERENCES "Playlist"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublishedRelease" ADD CONSTRAINT "PublishedRelease_creator_membership_fkey"
  FOREIGN KEY ("organizationId", "createdById")
  REFERENCES "Membership"("organizationId", "userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FrozenReleaseItem" ADD CONSTRAINT "FrozenReleaseItem_releaseId_organizationId_fkey"
  FOREIGN KEY ("releaseId", "organizationId")
  REFERENCES "PublishedRelease"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FrozenReleaseItem" ADD CONSTRAINT "FrozenReleaseItem_sourcePlaylistItemId_organizationId_fkey"
  FOREIGN KEY ("sourcePlaylistItemId", "organizationId")
  REFERENCES "PlaylistItem"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FrozenReleaseItem" ADD CONSTRAINT "FrozenReleaseItem_sourceAssetId_organizationId_fkey"
  FOREIGN KEY ("sourceAssetId", "organizationId")
  REFERENCES "MediaAsset"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReleaseAssignment" ADD CONSTRAINT "ReleaseAssignment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseAssignment" ADD CONSTRAINT "ReleaseAssignment_releaseId_organizationId_fkey"
  FOREIGN KEY ("releaseId", "organizationId")
  REFERENCES "PublishedRelease"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReleaseAssignment" ADD CONSTRAINT "ReleaseAssignment_scheduleId_organizationId_fkey"
  FOREIGN KEY ("scheduleId", "organizationId")
  REFERENCES "Schedule"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReleaseAssignment" ADD CONSTRAINT "ReleaseAssignment_creator_membership_fkey"
  FOREIGN KEY ("organizationId", "createdById")
  REFERENCES "Membership"("organizationId", "userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReleaseAssignment" ADD CONSTRAINT "ReleaseAssignment_previousAssignmentId_organizationId_fkey"
  FOREIGN KEY ("previousAssignmentId", "organizationId")
  REFERENCES "ReleaseAssignment"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReleaseAssignmentTarget" ADD CONSTRAINT "ReleaseAssignmentTarget_assignmentId_organizationId_fkey"
  FOREIGN KEY ("assignmentId", "organizationId")
  REFERENCES "ReleaseAssignment"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseAssignmentTarget" ADD CONSTRAINT "ReleaseAssignmentTarget_liveScreenId_liveScreenOrganizationId_fkey"
  FOREIGN KEY ("liveScreenId", "liveScreenOrganizationId")
  REFERENCES "Screen"("id", "organizationId")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
