-- Back Channel Remote paid tier (Stripe subscription) — docs/remote-paid-tier.md.
--
-- PURELY ADDITIVE: three new tables (BillingCustomer, RemoteSubscription, StripeEvent),
-- their indexes and two foreign keys to "Account"("id"). No existing table, column, index
-- or row is changed. The Account relation fields in schema.prisma are Prisma-side only and
-- add no Account columns. Generated with
--   prisma migrate diff --from-schema-datamodel <main's schema> --to-schema-datamodel prisma/schema.prisma --script
-- and checked on a real Postgres engine (PGlite) on top of main's full schema.
--
-- ============================================================================
-- LOUD NOTICE FOR SKYLAR: this migration touches the LIVE production database.
-- Nothing runs migrations automatically (no CI or cloudbuild step does).
--   1. Take an on-demand Cloud SQL backup of the backchannel instance first.
--   2. Prod migration tracking exists since 2026-09-24, so `npx prisma migrate status`
--      through the Cloud SQL proxy should list exactly this migration as pending.
--   3. Apply by hand:
--        cd apps/broker
--        DATABASE_URL="postgresql://backchannel-app:<password>@<proxy-host>/backchannel" \
--          npx prisma migrate deploy
--   Order: apply this migration BEFORE deploying the app that reads these tables. The relay
--   gate reads RemoteSubscription for any account without an active admin grant; without
--   the table those requests fail closed (503). Admin-granted accounts are read first and
--   keep working either way.
-- ============================================================================

-- CreateTable
CREATE TABLE "BillingCustomer" (
    "accountId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingCustomer_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "RemoteSubscription" (
    "stripeSubscriptionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "pastDueSince" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteSubscription_pkey" PRIMARY KEY ("stripeSubscriptionId")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingCustomer_stripeCustomerId_key" ON "BillingCustomer"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "RemoteSubscription_accountId_idx" ON "RemoteSubscription"("accountId");

-- CreateIndex
CREATE INDEX "StripeEvent_processedAt_idx" ON "StripeEvent"("processedAt");

-- AddForeignKey
ALTER TABLE "BillingCustomer" ADD CONSTRAINT "BillingCustomer_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteSubscription" ADD CONSTRAINT "RemoteSubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
