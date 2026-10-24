-- Account pairing, how a pairing came about (docs/appbridge-remote-access.md § Account pairing): Back Channel now records
-- whether the PC said, in its attest, that it enrolled the remote through the account, while an enrol leg between exactly
-- that PC and that remote was live. A PC can then learn which of its devices it enrolled through the owner's account from
-- here, not from its own records alone. False is "not both", never proof of a pairing on the PC's network.
--
-- ADDITIVE: one nullable column on "AppBridgePairing". No row is touched; every existing pairing reads null (unknown).
--
-- Order: apply this migration BEFORE deploying the app change that uses it (Prisma selects every scalar column).
--
-- Rollback: roll the app back first, then (only if wanted):
--   ALTER TABLE "AppBridgePairing" DROP COLUMN "attestedOnEnrolLeg";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

-- AlterTable
ALTER TABLE "AppBridgePairing" ADD COLUMN "attestedOnEnrolLeg" BOOLEAN;
