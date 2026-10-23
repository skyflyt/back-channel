-- Account pairing (docs/appbridge-remote-access.md § Account pairing): a phone registered to the account reaches the
-- account's PCs through the relay without pairing on each PC's network. The PC publishes what its pairing QR used to
-- carry (its inner-TLS key hash, its signed route descriptor, its LAN origin) and its owner's switch; a phone asks for
-- an "enrol" pass to a PC it has no pairing with, and the PC enrols it over that leg, vouched by Back Channel's record
-- of the phone's connector key.
--
-- ADDITIVE: five nullable-or-defaulted columns on "AppBridgeDevice", one defaulted boolean each on "AppBridgePass" and
-- "AppBridgeLease". No row is touched; accountPairing defaults to false until the PC reports its switch.
--
-- Order: apply this migration BEFORE deploying the app change that uses it (Prisma selects every scalar column).
--
-- Rollback: roll the app back first, then (only if wanted):
--   ALTER TABLE "AppBridgeDevice" DROP COLUMN "identitySpkiSha256", DROP COLUMN "routeDescriptor", DROP COLUMN "lanEndpoint",
--     DROP COLUMN "routeUpdatedAt", DROP COLUMN "accountPairing";
--   ALTER TABLE "AppBridgePass" DROP COLUMN "enrol"; ALTER TABLE "AppBridgeLease" DROP COLUMN "enrol";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

-- AlterTable
ALTER TABLE "AppBridgeDevice" ADD COLUMN "identitySpkiSha256" TEXT, ADD COLUMN "routeDescriptor" TEXT, ADD COLUMN "lanEndpoint" TEXT,
  ADD COLUMN "routeUpdatedAt" TIMESTAMP(3), ADD COLUMN "accountPairing" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AppBridgePass" ADD COLUMN "enrol" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AppBridgeLease" ADD COLUMN "enrol" BOOLEAN NOT NULL DEFAULT false;
