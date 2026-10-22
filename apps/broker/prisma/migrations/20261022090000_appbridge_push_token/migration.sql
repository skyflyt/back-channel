-- BC Remote push nudges (docs/secrets-epic.md §3.6). The phone app hands Back Channel its FCM registration token
-- (PUT /api/appbridge/v1/devices/self/push); when one of the account's secret broker requests is raised or answered,
-- Back Channel sends that token a data-only message that says nothing but "look". The phone then reads the list
-- with its own credential. The token is not a secret, but it is cleared whenever the device is revoked or
-- unregisters, so a gone device is never nudged.
--
-- ADDITIVE: two nullable columns on "AppBridgeDevice". No row is touched.
--
-- Order: apply this migration BEFORE deploying the app change that uses it (Prisma selects every scalar column, so
-- the new code fails every "AppBridgeDevice" query against a database without them). The old code never reads them,
-- so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted):
--   ALTER TABLE "AppBridgeDevice" DROP COLUMN "pushToken", DROP COLUMN "pushUpdatedAt";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

-- AlterTable
ALTER TABLE "AppBridgeDevice" ADD COLUMN "pushToken" TEXT, ADD COLUMN "pushUpdatedAt" TIMESTAMP(3);
