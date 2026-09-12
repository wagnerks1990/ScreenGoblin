-- Pairing codes have a deliberately small display space. Preserve claimed-code
-- history while allowing a code to be reused after it is no longer pending.
BEGIN;

-- Build the narrower constraint before removing the global one, so concurrent
-- issuance is protected for the entire migration.
CREATE UNIQUE INDEX "PairingCode_pending_codeHash_key"
  ON "PairingCode"("codeHash")
  WHERE "status" = 'PENDING';

DROP INDEX "PairingCode_codeHash_key";

CREATE INDEX "PairingCode_codeHash_idx" ON "PairingCode"("codeHash");

COMMIT;
