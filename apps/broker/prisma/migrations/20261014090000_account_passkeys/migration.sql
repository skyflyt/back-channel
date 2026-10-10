-- Passkey step-up for approvals (vault design/agent-desktop-scope.md, "Security decisions after the build", decided by
-- Skylar 2026-10-10; src/lib/step-up.ts; docs/remote-app-sessions.md, "Approvals need a passkey"). Agents may now drive
-- the whole PC, and that PC's signed-in browser can reach back-channel.app, so approving an agent session or a support
-- request, and connecting an agent, now need a WebAuthn step-up (Windows Hello, a phone or a security key) just before
-- the action. An agent can't complete one: it's a credential prompt, and a phone passkey needs the phone.
--
-- PURELY ADDITIVE: two new tables, each with a foreign key to "Account" (ON DELETE CASCADE, like every other
-- account-owned table) and CHECKs that only constrain their own rows. No existing table, column, index or row is
-- changed.
--   "AccountPasskey"    a passkey on the account: its credential id, its PUBLIC key (COSE), the authenticator's
--                       signature counter, how the browser reaches it, the person's label, when it was added and last
--                       used. Never a private key, never a secret.
--   "PasskeyChallenge"  the challenge store: one row per ceremony (register or step-up), spent by the first verify
--                       attempt (answeredAt). A step-up that verifies becomes a grant on the same row: bound to the
--                       account, the action and its target, at most 2 minutes, single-use (usedAt), and stored as a
--                       sha256 only (grantHash). Kept server-side, not in a signed cookie, because a grant must be
--                       spendable once across every Cloud Run instance, and no new signing secret is needed.
--
-- Order: apply this migration BEFORE deploying the app change that uses it. The new code reads "AccountPasskey" on
-- every approval and every agent connect (unless APPROVAL_STEP_UP=off), so it fails against a database without these
-- tables. The old code never reads them, so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted; it deletes every registered passkey, which people would have
-- to add again):
--   DROP TABLE "PasskeyChallenge";
--   DROP TABLE "AccountPasskey";
-- Rolling the app back alone needs nothing here. To keep the new app but stop enforcing the step-up (an emergency
-- only), set APPROVAL_STEP_UP=off on the service.
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

-- CreateTable
CREATE TABLE "AccountPasskey" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AccountPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyChallenge" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT,
    "targetId" TEXT,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "grantHash" TEXT,
    "passkeyId" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasskeyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountPasskey_credentialId_key" ON "AccountPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "AccountPasskey_accountId_idx" ON "AccountPasskey"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyChallenge_challenge_key" ON "PasskeyChallenge"("challenge");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyChallenge_grantHash_key" ON "PasskeyChallenge"("grantHash");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_accountId_createdAt_idx" ON "PasskeyChallenge"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountPasskey" ADD CONSTRAINT "AccountPasskey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT "PasskeyChallenge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountPasskey"
  -- base64url, as the browser reports it (a credential id is at most 1023 bytes).
  ADD CONSTRAINT "AccountPasskey_credential_shape" CHECK ("credentialId" ~ '^[A-Za-z0-9_-]{1,1400}$'),
  -- A COSE public key: RSA, EC2, OKP, or ML-DSA-44 (about 1.3 KiB), never more than 4 KiB.
  ADD CONSTRAINT "AccountPasskey_public_key_size" CHECK (octet_length("publicKey") BETWEEN 1 AND 4096),
  -- The signature counter is a uint32.
  ADD CONSTRAINT "AccountPasskey_counter_range" CHECK ("counter" BETWEEN 0 AND 4294967295),
  ADD CONSTRAINT "AccountPasskey_transports_size" CHECK ("transports" IS NULL OR cardinality("transports") <= 8),
  ADD CONSTRAINT "AccountPasskey_label_size" CHECK (char_length("label") BETWEEN 1 AND 60);

ALTER TABLE "PasskeyChallenge"
  -- A registration carries no target or grant, and an action only to say a manage_passkeys step-up authorized it
  -- (an account that already has a passkey); a step-up names one of the four actions, and only the two approvals (and
  -- always they) name their target.
  ADD CONSTRAINT "PasskeyChallenge_kind_check" CHECK (
    ("kind" = 'register' AND ("action" IS NULL OR "action" = 'manage_passkeys') AND "targetId" IS NULL AND "grantHash" IS NULL AND "usedAt" IS NULL) OR
    ("kind" = 'step_up' AND "action" IN ('approve_session','approve_support','connect_agent','manage_passkeys')
      AND ("action" IN ('approve_session','approve_support')) = ("targetId" IS NOT NULL))),
  ADD CONSTRAINT "PasskeyChallenge_target_size" CHECK ("targetId" IS NULL OR char_length("targetId") <= 64),
  -- A grant exists only once its challenge was answered, and is spent only if it exists.
  ADD CONSTRAINT "PasskeyChallenge_grant_order" CHECK (("grantHash" IS NULL OR "answeredAt" IS NOT NULL) AND ("usedAt" IS NULL OR "grantHash" IS NOT NULL));
