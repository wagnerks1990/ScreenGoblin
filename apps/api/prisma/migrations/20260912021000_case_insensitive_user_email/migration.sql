-- Authentication normalizes email addresses to lowercase. Refuse to choose an
-- arbitrary account if legacy data contains case-only variants. The table lock
-- closes the check/index race while still permitting reads during deployment.
BEGIN;

LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;

DO $identity_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    GROUP BY LOWER("email")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Cannot enforce case-insensitive user email uniqueness: duplicate normalized emails exist';
  END IF;
END
$identity_preflight$;

CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (LOWER("email"));

COMMIT;
