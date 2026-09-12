-- After session authority epochs, add stable, tenant-bound location
-- classifications without changing the
-- existing organization-role authorization policy. The legacy Screen.location
-- label remains intact for API and Player compatibility.
CREATE TABLE "Location" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Location_id_organizationId_key"
  ON "Location"("id", "organizationId");
CREATE UNIQUE INDEX "Location_organizationId_name_key"
  ON "Location"("organizationId", "name");
CREATE INDEX "Location_organizationId_createdAt_idx"
  ON "Location"("organizationId", "createdAt");

ALTER TABLE "Location"
  ADD CONSTRAINT "Location_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Screen" ADD COLUMN "locationId" TEXT;

WITH labels AS (
  SELECT DISTINCT
    screen."organizationId",
    CASE
      WHEN BTRIM(screen."location") = '' THEN 'Unassigned'
      ELSE BTRIM(screen."location")
    END AS name
  FROM "Screen" screen
)
INSERT INTO "Location" ("id", "organizationId", "name")
SELECT
  'legacy-location-' || MD5(labels."organizationId" || ':' || labels.name),
  labels."organizationId",
  labels.name
FROM labels;

UPDATE "Screen" screen
SET "locationId" = location."id"
FROM "Location" location
WHERE location."organizationId" = screen."organizationId"
  AND location.name = CASE
    WHEN BTRIM(screen."location") = '' THEN 'Unassigned'
    ELSE BTRIM(screen."location")
  END;

ALTER TABLE "Screen"
  ADD CONSTRAINT "Screen_locationId_organizationId_fkey"
  FOREIGN KEY ("locationId", "organizationId")
  REFERENCES "Location"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Screen_organizationId_locationId_idx"
  ON "Screen"("organizationId", "locationId");
