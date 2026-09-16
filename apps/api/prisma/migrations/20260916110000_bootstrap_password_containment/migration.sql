BEGIN;

-- This identity-boundary migration deliberately takes coordinated-downtime
-- locks. A session writer locks User before inserting UserSession, so retaining
-- that order avoids admitting a FULL session concurrently with a bootstrap
-- marker change.
LOCK TABLE "User" IN EXCLUSIVE MODE;
LOCK TABLE "UserSession" IN EXCLUSIVE MODE;

CREATE TYPE "UserSessionPurpose" AS ENUM (
  'FULL',
  'BOOTSTRAP_PASSWORD_ROTATION'
);

ALTER TABLE "User"
  ADD COLUMN "bootstrapPasswordExpiresAt" TIMESTAMP(3);

ALTER TABLE "UserSession"
  ADD COLUMN "purpose" "UserSessionPurpose" NOT NULL DEFAULT 'FULL',
  ADD CONSTRAINT "UserSession_purpose_max_lifetime" CHECK (
    "expiresAt" > "createdAt" AND (
      ("purpose" = 'FULL' AND "expiresAt" <= "createdAt" + INTERVAL '1 hour') OR
      ("purpose" = 'BOOTSTRAP_PASSWORD_ROTATION' AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes')
    )
  );

CREATE OR REPLACE FUNCTION "enforce_user_session_purpose"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $enforce_user_session_purpose$
DECLARE
  bootstrap_deadline TIMESTAMP(3);
BEGIN
  SELECT actor."bootstrapPasswordExpiresAt"
    INTO bootstrap_deadline
    FROM public."User" actor
   WHERE actor.id = NEW."userId"
   FOR KEY SHARE;

  IF NOT FOUND THEN
    -- The membership foreign key will reject this row. Keeping this trigger's
    -- response generic avoids adding a separate user-existence oracle.
    RETURN NEW;
  END IF;

  IF NEW."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Session expiry must be in the future'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."purpose" = 'FULL' THEN
    IF bootstrap_deadline IS NOT NULL THEN
      RAISE EXCEPTION 'FULL sessions are unavailable for bootstrap credentials'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF bootstrap_deadline IS NULL
     OR bootstrap_deadline <= CURRENT_TIMESTAMP
     OR NEW."expiresAt" > bootstrap_deadline THEN
    RAISE EXCEPTION 'Bootstrap rotation session exceeds its credential deadline'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$enforce_user_session_purpose$;

CREATE TRIGGER "UserSession_enforce_purpose"
BEFORE INSERT OR UPDATE OF "userId", "purpose", "expiresAt", "createdAt"
ON "UserSession"
FOR EACH ROW
EXECUTE FUNCTION "enforce_user_session_purpose"();

COMMIT;
