-- Account pairing, how a pairing came about (docs/appbridge-remote-access.md § Account pairing): the PC attests every
-- pairing the same way, so Back Channel now records whether an enrol leg between that PC and that remote was live when
-- the PC attested it. A PC can then learn which of its devices it enrolled through the owner's account from here, not
-- from its own records alone.
--
-- ADDITIVE: one nullable column on "AppBridgePairing". No row is touched; every existing pairing reads null (unknown).
--
-- Order: apply this migration BEFORE deploying the app change that uses it (Prisma selects every scalar column).
--
-- Rollback: roll the app back first, then (only if wanted):
--   ALTER TABLE "AppBridgePairing" DROP COLUMN "viaAccount";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

-- AlterTable
ALTER TABLE "AppBridgePairing" ADD COLUMN "viaAccount" BOOLEAN;
