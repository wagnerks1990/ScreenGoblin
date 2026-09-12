-- Enforce tenant ownership at the database boundary. Abort before changing the
-- schema if legacy rows cross organizations; those rows require investigation,
-- not an automatic ownership rewrite.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PlaylistItem" item
    JOIN "Playlist" playlist ON playlist."id" = item."playlistId"
    JOIN "MediaAsset" asset ON asset."id" = item."assetId"
    WHERE playlist."organizationId" <> asset."organizationId"
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: PlaylistItem references a cross-organization asset';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Schedule" schedule
    JOIN "Playlist" playlist ON playlist."id" = schedule."playlistId"
    WHERE schedule."organizationId" <> playlist."organizationId"
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: Schedule references a cross-organization playlist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ScheduleTarget" target
    JOIN "Schedule" schedule ON schedule."id" = target."scheduleId"
    JOIN "Screen" screen ON screen."id" = target."screenId"
    WHERE schedule."organizationId" <> screen."organizationId"
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: ScheduleTarget references a cross-organization screen';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PairingCode" pairing
    JOIN "Screen" screen ON screen."id" = pairing."screenId"
    WHERE pairing."organizationId" <> screen."organizationId"
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: PairingCode references a cross-organization screen';
  END IF;
END $$;

ALTER TABLE "PlaylistItem" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "ScheduleTarget" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "PairingCode" ADD COLUMN "screenOrganizationId" TEXT;

UPDATE "PlaylistItem" item
SET "organizationId" = playlist."organizationId"
FROM "Playlist" playlist
WHERE playlist."id" = item."playlistId";

UPDATE "ScheduleTarget" target
SET "organizationId" = schedule."organizationId"
FROM "Schedule" schedule
WHERE schedule."id" = target."scheduleId";

UPDATE "PairingCode"
SET "screenOrganizationId" = "organizationId"
WHERE "screenId" IS NOT NULL;

ALTER TABLE "PlaylistItem" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ScheduleTarget" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE UNIQUE INDEX "Screen_id_organizationId_key"
  ON "Screen"("id", "organizationId");
CREATE UNIQUE INDEX "MediaAsset_id_organizationId_key"
  ON "MediaAsset"("id", "organizationId");
CREATE UNIQUE INDEX "Playlist_id_organizationId_key"
  ON "Playlist"("id", "organizationId");
CREATE UNIQUE INDEX "Schedule_id_organizationId_key"
  ON "Schedule"("id", "organizationId");

ALTER TABLE "PlaylistItem" DROP CONSTRAINT "PlaylistItem_playlistId_fkey";
ALTER TABLE "PlaylistItem" DROP CONSTRAINT "PlaylistItem_assetId_fkey";
ALTER TABLE "Schedule" DROP CONSTRAINT "Schedule_playlistId_fkey";
ALTER TABLE "ScheduleTarget" DROP CONSTRAINT "ScheduleTarget_scheduleId_fkey";
ALTER TABLE "ScheduleTarget" DROP CONSTRAINT "ScheduleTarget_screenId_fkey";
ALTER TABLE "PairingCode" DROP CONSTRAINT "PairingCode_screenId_fkey";

ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_playlistId_organizationId_fkey"
  FOREIGN KEY ("playlistId", "organizationId")
  REFERENCES "Playlist"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_assetId_organizationId_fkey"
  FOREIGN KEY ("assetId", "organizationId")
  REFERENCES "MediaAsset"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_playlistId_organizationId_fkey"
  FOREIGN KEY ("playlistId", "organizationId")
  REFERENCES "Playlist"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleTarget" ADD CONSTRAINT "ScheduleTarget_scheduleId_organizationId_fkey"
  FOREIGN KEY ("scheduleId", "organizationId")
  REFERENCES "Schedule"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleTarget" ADD CONSTRAINT "ScheduleTarget_screenId_organizationId_fkey"
  FOREIGN KEY ("screenId", "organizationId")
  REFERENCES "Screen"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Both relation columns are nullable so deleting a screen can detach the link
-- without deleting pairing history. The check binds that nullable relation to
-- the pairing's immutable organization ownership.
ALTER TABLE "PairingCode" ADD CONSTRAINT "PairingCode_screen_organization_check"
  CHECK (
    ("screenId" IS NULL AND "screenOrganizationId" IS NULL)
    OR
    ("screenId" IS NOT NULL AND "screenOrganizationId" = "organizationId")
  );
ALTER TABLE "PairingCode" ADD CONSTRAINT "PairingCode_screenId_screenOrganizationId_fkey"
  FOREIGN KEY ("screenId", "screenOrganizationId")
  REFERENCES "Screen"("id", "organizationId")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
