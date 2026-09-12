ALTER TABLE "User"
ADD COLUMN "authenticationEpoch" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "User_authenticationEpoch_nonnegative" CHECK ("authenticationEpoch" >= 0);

ALTER TABLE "Membership"
ADD COLUMN "authorizationEpoch" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "Membership_authorizationEpoch_nonnegative" CHECK ("authorizationEpoch" >= 0);

ALTER TABLE "UserSession"
ADD COLUMN "authenticationEpoch" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "authorizationEpoch" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "UserSession_authenticationEpoch_nonnegative" CHECK ("authenticationEpoch" >= 0),
ADD CONSTRAINT "UserSession_authorizationEpoch_nonnegative" CHECK ("authorizationEpoch" >= 0);
