-- Existing URL-backed metadata does not prove that a matching object exists at
-- the new private tenant key. Refuse populated upgrades until an operator has
-- copied each object, verified its SHA-256 and byte size, and applied an
-- explicitly reviewed metadata migration.
DO $private_media_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM "MediaAsset")
    OR EXISTS (SELECT 1 FROM "FrozenReleaseItem") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'private media migration requires an empty media catalog; migrate and verify legacy objects before retrying';
  END IF;
END
$private_media_preflight$;

ALTER TABLE "MediaAsset" ADD COLUMN "storageKey" TEXT NOT NULL;
CREATE UNIQUE INDEX "MediaAsset_organizationId_storageKey_key"
  ON "MediaAsset"("organizationId", "storageKey");

ALTER TABLE "FrozenReleaseItem" ADD COLUMN "assetStorageKey" TEXT NOT NULL;
