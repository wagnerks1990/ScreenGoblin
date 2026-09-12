-- Keep opportunistic maintenance candidate discovery index-bounded as
-- permanent idempotency tombstones and device challenge history grow.
BEGIN;

DROP INDEX "IdempotencyRecord_expiresAt_idx";
CREATE INDEX "IdempotencyRecord_expiresAt_id_idx"
  ON "IdempotencyRecord"("expiresAt", "id");
CREATE INDEX "IdempotencyRecord_compactable_response_idx"
  ON "IdempotencyRecord"("expiresAt", "id")
  WHERE "responseBody" IS NOT NULL;

DROP INDEX "DeviceAuthChallenge_expiresAt_idx";
CREATE INDEX "DeviceAuthChallenge_expiresAt_id_idx"
  ON "DeviceAuthChallenge"("expiresAt", "id");

COMMIT;
