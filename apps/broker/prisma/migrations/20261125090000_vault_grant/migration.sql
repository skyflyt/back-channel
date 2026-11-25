-- The per-connector vault grant (docs/vault-bridge.md, step 4): which hosted connectors may use the read-only
-- bc_vault_* tools. One row per connector, turned on with a passkey from the dashboard, deleted to turn it off.
--
-- ADDITIVE: a new table only. No existing table or row is touched. Until it exists, the broker treats every
-- connector as having no grant (closed), so this can be applied before or after the app change.

-- CreateTable
CREATE TABLE "VaultGrant" (
    "agentTokenId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "passkeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultGrant_pkey" PRIMARY KEY ("agentTokenId")
);

-- CreateIndex
CREATE INDEX "VaultGrant_accountId_idx" ON "VaultGrant"("accountId");

-- AddForeignKey
ALTER TABLE "VaultGrant" ADD CONSTRAINT "VaultGrant_agentTokenId_fkey" FOREIGN KEY ("agentTokenId") REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
