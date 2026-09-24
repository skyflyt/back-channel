-- Back Channel Remote (AppBridge): crash-safe credential rotation — docs/appbridge-remote-access.md.
--
-- PURELY ADDITIVE: one new nullable column on AppBridgeCredential. No existing column, index or row
-- is changed; existing rows read as NULL ("replaces nothing"), which is exactly today's behaviour.
--
-- replacesKeyHash = the keyHash of the credential this one replaced at POST /devices/self/credential.
-- The replaced credential stays valid until this one is first used (it is then revoked and this is
-- cleared) or for 24 h at most, so a PC that crashes before saving the new credential is not locked out.
--
-- Order: apply this migration BEFORE deploying the app change that reads/writes the column (Prisma
-- selects every scalar column, so the new code fails against a database without it). The old code
-- ignores the column, so applying it first is safe.
--
-- LOUD NOTICE FOR SKYLAR: this touches the LIVE production database. Take an on-demand Cloud SQL
-- backup first, then `npx prisma migrate deploy` through the Cloud SQL proxy applies exactly this.

-- AlterTable
ALTER TABLE "AppBridgeCredential" ADD COLUMN "replacesKeyHash" TEXT;
