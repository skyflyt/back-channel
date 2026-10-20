-- Secrets epic, Phase 1 (docs/secrets-epic.md §3.1, §3.3, §3.4; ruled by Skylar 2026-10-20). A person approves a
-- secret broker request on one of their PCs from their phone, with a passkey whose WebAuthn challenge is the broker's
-- own digest; the worker on the PC carries the request out and the assertion back, and the broker checks it itself.
-- The Remote page also shows each PC's broker (installed commit, healthy, names, lockdown) and can ask the worker to
-- install or update the pinned broker release, trust a passkey for phone approvals, or lock the broker down.
--
-- ADDITIVE, plus one widened CHECK:
--   "SecretRequest"  one request waiting on the person: what the broker's prompt shows (names, modes, hosts, the request
--                    code; never a value), its digests, and once decided the passkey's assertion for the worker to
--                    collect (not a secret: a signature over a digest), cleared when collected.
--   "SecretJob"      one thing asked of a PC's worker: install/update (a commit and tree hash), enrol (a passkey's
--                    PUBLIC key), lockdown; its state and progress as booleans.
--   "AgentToken"     two nullable columns: the worker's last status of its PC's broker, and when it was received.
--   "PasskeyChallenge_kind_check"  also allows the step-up actions approve_secret (target: the SecretRequest) and
--                    secret_broker_admin (target: the PC's worker). Dropped and added in one statement, so there is no
--                    window without the constraint.
--
-- Order: apply this migration BEFORE deploying the app change that uses it. The new code selects the new AgentToken
-- columns (Prisma selects every scalar column), so every query on "AgentToken" fails against a database without them.
-- The old code never reads them, so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted):
--   DROP TABLE "SecretJob"; DROP TABLE "SecretRequest";
--   ALTER TABLE "AgentToken" DROP COLUMN "secretBroker", DROP COLUMN "secretBrokerAt";
--   and restore the five-action "PasskeyChallenge_kind_check" from 20261014090000_account_passkeys (after deleting any
--   step_up rows with the two new actions).
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

-- AlterTable
ALTER TABLE "AgentToken" ADD COLUMN "secretBroker" JSONB, ADD COLUMN "secretBrokerAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SecretRequest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "tier" INTEGER,
    "target" TEXT,
    "requestCode" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "requester" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "option" INTEGER,
    "assertion" JSONB,
    "decidedBy" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "SecretRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretJob" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'requested',
    "progress" JSONB,
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SecretJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecretRequest_agentId_ref_key" ON "SecretRequest"("agentId", "ref");

-- CreateIndex
CREATE INDEX "SecretRequest_accountId_status_raisedAt_idx" ON "SecretRequest"("accountId", "status", "raisedAt");

-- CreateIndex
CREATE INDEX "SecretJob_agentId_state_idx" ON "SecretJob"("agentId", "state");

-- CreateIndex
CREATE INDEX "SecretJob_accountId_createdAt_idx" ON "SecretJob"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "SecretRequest" ADD CONSTRAINT "SecretRequest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretRequest" ADD CONSTRAINT "SecretRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretJob" ADD CONSTRAINT "SecretJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretJob" ADD CONSTRAINT "SecretJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecretRequest"
  ADD CONSTRAINT "SecretRequest_ref_shape" CHECK ("ref" ~ '^[A-Za-z0-9_-]{16,64}$'),
  ADD CONSTRAINT "SecretRequest_kind_check" CHECK ("kind" IN ('serve','unlock','policy','import','rotation-check')),
  ADD CONSTRAINT "SecretRequest_status_check" CHECK ("status" IN ('open','approved','denied','expired','closed')),
  ADD CONSTRAINT "SecretRequest_tier_range" CHECK ("tier" IS NULL OR "tier" BETWEEN 0 AND 3),
  ADD CONSTRAINT "SecretRequest_code_shape" CHECK ("requestCode" ~ '^[A-Z0-9]{4,12}$'),
  ADD CONSTRAINT "SecretRequest_digest_shape" CHECK ("digest" ~ '^[A-Za-z0-9_-]{43}$'),
  ADD CONSTRAINT "SecretRequest_sizes" CHECK (char_length("name") BETWEEN 1 AND 200 AND char_length("mode") BETWEEN 1 AND 40
    AND ("target" IS NULL OR char_length("target") <= 300) AND char_length("display") BETWEEN 1 AND 8000),
  -- An approval carries the passkey's assertion until the worker collects it; nothing else ever does.
  ADD CONSTRAINT "SecretRequest_assertion_only_when_approved" CHECK ("assertion" IS NULL OR "status" = 'approved'),
  ADD CONSTRAINT "SecretRequest_option_range" CHECK ("option" IS NULL OR "option" BETWEEN 0 AND 31);

ALTER TABLE "SecretJob"
  ADD CONSTRAINT "SecretJob_kind_check" CHECK ("kind" IN ('install','update','enrol','lockdown')),
  ADD CONSTRAINT "SecretJob_state_check" CHECK ("state" IN ('requested','sent','running','done','failed')),
  ADD CONSTRAINT "SecretJob_failure_size" CHECK ("failure" IS NULL OR "failure" ~ '^[a-z0-9_]{1,40}$');

ALTER TABLE "PasskeyChallenge"
  DROP CONSTRAINT "PasskeyChallenge_kind_check",
  ADD CONSTRAINT "PasskeyChallenge_kind_check" CHECK (
    ("kind" = 'register' AND ("action" IS NULL OR "action" = 'manage_passkeys') AND "targetId" IS NULL AND "grantHash" IS NULL AND "usedAt" IS NULL) OR
    ("kind" = 'step_up' AND "action" IN ('approve_session','resume_session','approve_support','connect_agent','manage_passkeys','approve_secret','secret_broker_admin')
      AND ("action" IN ('approve_session','resume_session','approve_support','approve_secret','secret_broker_admin')) = ("targetId" IS NOT NULL)));
