-- Back Channel Remote (AppBridge) remote access — docs/appbridge-remote-access.md.
--
-- PURELY ADDITIVE: eight new AppBridge* tables, their indexes and foreign keys.
-- No existing table, column, index or row is changed. The Account relation
-- fields in schema.prisma are Prisma-side only and add no Account columns.
--
-- ============================================================================
-- LOUD NOTICE FOR SKYLAR: this migration touches the LIVE production database.
-- Nothing runs migrations automatically (no CI or cloudbuild step does). Before
-- applying it:
--   1. Take an on-demand Cloud SQL backup of the backchannel instance.
--   2. Check migration tracking: prod may predate `_prisma_migrations` (earlier
--      schema changes used `db push`). Run `npx prisma migrate status` against
--      prod first; if it reports earlier migrations as unapplied although their
--      tables exist, mark those with `prisma migrate resolve --applied <name>`
--      rather than letting deploy re-run them.
--   3. Apply by hand through the Cloud SQL proxy:
--        cd apps/broker
--        DATABASE_URL="postgresql://backchannel-app:<password>@<proxy-host>/backchannel" --          npx prisma migrate deploy
-- ============================================================================

-- CreateTable
CREATE TABLE "AppBridgeDevice" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "label" TEXT,
    "connectorSpki" TEXT NOT NULL,
    "connectorSpkiSha256" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "relayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AppBridgeDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppBridgeCredential" (
    "keyHash" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AppBridgeCredential_pkey" PRIMARY KEY ("keyHash")
);

-- CreateTable
CREATE TABLE "AppBridgeDeviceCode" (
    "codeHash" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AppBridgeDeviceCode_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "AppBridgePairing" (
    "hostDeviceId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "remoteDeviceId" TEXT NOT NULL,
    "attestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "AppBridgePairing_pkey" PRIMARY KEY ("hostDeviceId","enrollmentId")
);

-- CreateTable
CREATE TABLE "AppBridgeEntitlement" (
    "accountId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppBridgeEntitlement_pkey" PRIMARY KEY ("accountId","feature")
);

-- CreateTable
CREATE TABLE "AppBridgePass" (
    "passHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "hostDeviceId" TEXT NOT NULL,
    "remoteDeviceId" TEXT,
    "enrollmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "AppBridgePass_pkey" PRIMARY KEY ("passHash")
);

-- CreateTable
CREATE TABLE "AppBridgeLease" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "hostDeviceId" TEXT NOT NULL,
    "remoteDeviceId" TEXT,
    "enrollmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppBridgeLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppBridgeConnectionEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "hostDeviceId" TEXT NOT NULL,
    "remoteDeviceId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppBridgeConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppBridgeDevice_accountId_idx" ON "AppBridgeDevice"("accountId");

-- CreateIndex
CREATE INDEX "AppBridgeDevice_connectorSpkiSha256_idx" ON "AppBridgeDevice"("connectorSpkiSha256");

-- CreateIndex
CREATE INDEX "AppBridgeCredential_deviceId_idx" ON "AppBridgeCredential"("deviceId");

-- CreateIndex
CREATE INDEX "AppBridgeDeviceCode_accountId_idx" ON "AppBridgeDeviceCode"("accountId");

-- CreateIndex
CREATE INDEX "AppBridgeDeviceCode_expiresAt_idx" ON "AppBridgeDeviceCode"("expiresAt");

-- CreateIndex
CREATE INDEX "AppBridgePairing_remoteDeviceId_idx" ON "AppBridgePairing"("remoteDeviceId");

-- CreateIndex
CREATE INDEX "AppBridgePass_expiresAt_idx" ON "AppBridgePass"("expiresAt");

-- CreateIndex
CREATE INDEX "AppBridgeLease_expiresAt_idx" ON "AppBridgeLease"("expiresAt");

-- CreateIndex
CREATE INDEX "AppBridgeConnectionEvent_accountId_at_idx" ON "AppBridgeConnectionEvent"("accountId", "at");

-- CreateIndex
CREATE INDEX "AppBridgeConnectionEvent_at_idx" ON "AppBridgeConnectionEvent"("at");

-- AddForeignKey
ALTER TABLE "AppBridgeDevice" ADD CONSTRAINT "AppBridgeDevice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppBridgeCredential" ADD CONSTRAINT "AppBridgeCredential_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "AppBridgeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppBridgeDeviceCode" ADD CONSTRAINT "AppBridgeDeviceCode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppBridgePairing" ADD CONSTRAINT "AppBridgePairing_hostDeviceId_fkey" FOREIGN KEY ("hostDeviceId") REFERENCES "AppBridgeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppBridgePairing" ADD CONSTRAINT "AppBridgePairing_remoteDeviceId_fkey" FOREIGN KEY ("remoteDeviceId") REFERENCES "AppBridgeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppBridgeEntitlement" ADD CONSTRAINT "AppBridgeEntitlement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppBridgeConnectionEvent" ADD CONSTRAINT "AppBridgeConnectionEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constrain the enumerations the application relies on.
ALTER TABLE "AppBridgeDevice" ADD CONSTRAINT "AppBridgeDevice_role_check" CHECK ("role" IN ('host','remote'));
ALTER TABLE "AppBridgeDeviceCode" ADD CONSTRAINT "AppBridgeDeviceCode_role_check" CHECK ("role" IN ('host','remote'));
ALTER TABLE "AppBridgePass" ADD CONSTRAINT "AppBridgePass_purpose_check" CHECK ("purpose" IN ('session','presence'));
ALTER TABLE "AppBridgeLease" ADD CONSTRAINT "AppBridgeLease_purpose_check" CHECK ("purpose" IN ('session','presence'));
