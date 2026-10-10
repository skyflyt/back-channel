-- Remote support: one-time, consented help for someone else through a temporary client
-- (docs/remote-support.md; design "Phase B", decisions taken 2026-10-09: owner-only in v1, view-first,
-- a 45-minute cap, a rate-limited capability of a Remote subscriber).
--
-- ADDITIVE, with deliberate WIDENINGS of existing CHECKs (each one drops and re-adds a constraint in a
-- single ALTER TABLE statement, so there is no moment without a check):
--   - two new tables, SupportInvite and SupportReport, with their indexes and CHECKs;
--   - seven new NULLABLE columns on RemoteAppSession (helperLabel, supportKeySha256, supportKeySpki,
--     supportCredentialHash, supportCredentialExpiresAt, removal, removalAt), a unique index on
--     supportCredentialHash and an index on supportKeySha256;
--   - RemoteAppSession CHECKs:
--       endReason       WIDENED: also 'reported' (the helped person said "I didn't ask for this");
--       consentVia      WIDENED: also 'helper' (Allow on the helped person's own screen), and only for
--                       kind 'support'; a support session is never 'web';
--       apps_size       WIDENED: a support session has an EMPTY app list (cardinality 0), an agent
--                       session still has 1 to 8 apps, exactly as before;
--       plus NEW checks that bind every support column to kind 'support', cap a support session at
--       45 minutes, and keep support sessions out of 'blocked' and executor hand-offs;
--   - RemoteAppActionLog outcome WIDENED: also 'declined' (the helped person said no on their screen);
--   - AppBridgePass and AppBridgeLease purpose WIDENED: also 'support' (the helper's relay lease), and
--     the session binding widened from 'agent' alone to 'agent' or 'support'.
-- No existing row, column or index is changed or dropped, and every existing row satisfies every new or
-- widened check (no row has kind 'support', outcome 'declined', purpose 'support' or a support column).
--
-- RemoteAppSession."hostDeviceId" stays NOT NULL. For a support session it is NOT a device: it holds the
-- helper's ephemeral relay identity, "support_" followed by 22 base64url characters, minted at redemption.
-- AppBridgeDevice ids are exactly 22 characters, so the two can never collide, and every Phase A query that
-- treats hostDeviceId as a PC either filters kind = 'agent' or looks a device up by that id and finds none.
--
-- Stored: who asked (agent and account), who it's for in the agent's words, the task text, the minutes,
-- the code's HASH and times, the helper's public key and its credential's HASH, the steps as fixed kinds
-- with a bounded control name and an outcome, the removal receipt, and reports. Never the code, the
-- credential, anything on the helped person's screen, anything typed, or an IP address.
--
-- Order: apply this migration BEFORE deploying the app change that uses it. The old code never reads the
-- new tables or columns and never writes any widened value, so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted; it destroys the support history):
--   DELETE FROM "AppBridgeLease" WHERE "purpose" = 'support';
--   DELETE FROM "AppBridgePass" WHERE "purpose" = 'support';
--   DELETE FROM "RemoteAppActionLog" WHERE "sessionId" IN (SELECT "id" FROM "RemoteAppSession" WHERE "kind" = 'support');
--   DELETE FROM "RemoteAppSession" WHERE "kind" = 'support';
--   then restore the Phase A checks exactly as 20261009220000_remote_app_sessions created them (purpose,
--   agent_binding, outcome, endReason, consentVia, apps_size), drop the support_* checks and the new
--   columns and indexes, and DROP TABLE "SupportReport", "SupportInvite".
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL
-- backup, check `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

CREATE TABLE "SupportInvite" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "agentTokenId" TEXT NOT NULL,
  "forName" TEXT NOT NULL,
  "task" TEXT NOT NULL,
  "minutes" INTEGER NOT NULL,
  "listTaskId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "codeHash" TEXT,
  "mintedAt" TIMESTAMP(3),
  "codeExpiresAt" TIMESTAMP(3),
  "redeemedAt" TIMESTAMP(3),
  "sessionId" TEXT,
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportInvite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportInvite_status_check" CHECK ("status" IN ('requested','denied','lapsed','withdrawn','minted','voided','expired','reported','redeemed')),
  CONSTRAINT "SupportInvite_minutes_check" CHECK ("minutes" BETWEEN 1 AND 45),
  CONSTRAINT "SupportInvite_task_size" CHECK (char_length("task") BETWEEN 1 AND 300),
  CONSTRAINT "SupportInvite_forName_size" CHECK (char_length("forName") BETWEEN 1 AND 60),
  -- A code is a sha256 hex digest, minted with its 15-minute redeem window; never anything readable.
  CONSTRAINT "SupportInvite_codeHash_shape" CHECK ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SupportInvite_code_window" CHECK (("codeHash" IS NULL) = ("mintedAt" IS NULL) AND ("mintedAt" IS NULL) = ("codeExpiresAt" IS NULL)
    AND ("codeExpiresAt" IS NULL OR "codeExpiresAt" <= "mintedAt" + INTERVAL '15 minutes')),
  -- Only a request waiting for its person, or one they turned down or let lapse, or one withdrawn before minting, has no code.
  CONSTRAINT "SupportInvite_minted_states" CHECK (("codeHash" IS NULL) = ("status" IN ('requested','denied','lapsed') OR ("status" = 'withdrawn' AND "mintedAt" IS NULL))),
  -- Redeemed exactly when it names its session.
  CONSTRAINT "SupportInvite_redeemed" CHECK (("redeemedAt" IS NOT NULL) = ("sessionId" IS NOT NULL) AND ("sessionId" IS NULL OR "status" IN ('redeemed','reported')))
);
CREATE UNIQUE INDEX "SupportInvite_codeHash_key" ON "SupportInvite"("codeHash");
CREATE UNIQUE INDEX "SupportInvite_sessionId_key" ON "SupportInvite"("sessionId");
CREATE INDEX "SupportInvite_accountId_status_idx" ON "SupportInvite"("accountId", "status");
CREATE INDEX "SupportInvite_accountId_mintedAt_idx" ON "SupportInvite"("accountId", "mintedAt");
CREATE INDEX "SupportInvite_agentTokenId_idx" ON "SupportInvite"("agentTokenId");

CREATE TABLE "SupportReport" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "inviteId" TEXT NOT NULL,
  "sessionId" TEXT,
  "via" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportReport_via_check" CHECK ("via" IN ('page','helper'))
);
CREATE INDEX "SupportReport_accountId_createdAt_idx" ON "SupportReport"("accountId", "createdAt");
CREATE INDEX "SupportReport_inviteId_idx" ON "SupportReport"("inviteId");

-- The support columns: all nullable, all null for every existing (agent) session.
ALTER TABLE "RemoteAppSession"
  ADD COLUMN "helperLabel" TEXT,
  ADD COLUMN "supportKeySha256" TEXT,
  ADD COLUMN "supportKeySpki" TEXT,
  ADD COLUMN "supportCredentialHash" TEXT,
  ADD COLUMN "supportCredentialExpiresAt" TIMESTAMP(3),
  ADD COLUMN "removal" TEXT,
  ADD COLUMN "removalAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "RemoteAppSession_supportCredentialHash_key" ON "RemoteAppSession"("supportCredentialHash");
CREATE INDEX "RemoteAppSession_supportKeySha256_idx" ON "RemoteAppSession"("supportKeySha256");

ALTER TABLE "RemoteAppSession"
  -- Widened: 'reported'.
  DROP CONSTRAINT "RemoteAppSession_endReason_check",
  ADD CONSTRAINT "RemoteAppSession_endReason_check" CHECK ("endReason" IS NULL OR "endReason" IN ('done','user_stop','host_stop','agent_stop','lapsed','fail_closed','revoked','reported')),
  -- Widened: 'helper', for support sessions only; an agent session is still approved on the web only.
  DROP CONSTRAINT "RemoteAppSession_consentVia_check",
  ADD CONSTRAINT "RemoteAppSession_consentVia_check" CHECK ("consentVia" IS NULL OR ("kind" = 'agent' AND "consentVia" = 'web') OR ("kind" = 'support' AND "consentVia" = 'helper')),
  -- Widened: a support session has no app allow-list (the helped person shares what they choose, and
  -- confirms each action); an agent session keeps 1 to 8 apps.
  DROP CONSTRAINT "RemoteAppSession_apps_size",
  ADD CONSTRAINT "RemoteAppSession_apps_size" CHECK ("appAllowList" IS NOT NULL AND (("kind" = 'agent' AND cardinality("appAllowList") BETWEEN 1 AND 8) OR ("kind" = 'support' AND cardinality("appAllowList") = 0))),
  -- New: the 45-minute cap for support, on the minutes and on the running window.
  ADD CONSTRAINT "RemoteAppSession_support_minutes" CHECK ("kind" <> 'support' OR "minutes" BETWEEN 1 AND 45),
  ADD CONSTRAINT "RemoteAppSession_support_window" CHECK ("kind" <> 'support' OR "expiresAt" IS NULL OR "expiresAt" <= "startedAt" + INTERVAL '45 minutes'),
  -- New: a support session is pinned to one key and one credential from birth; an agent session has none of it.
  ADD CONSTRAINT "RemoteAppSession_support_binding" CHECK (("kind" = 'support') = ("supportKeySha256" IS NOT NULL) AND ("supportKeySha256" IS NULL) = ("supportKeySpki" IS NULL)
    AND ("supportKeySha256" IS NULL) = ("supportCredentialHash" IS NULL) AND ("supportKeySha256" IS NULL) = ("supportCredentialExpiresAt" IS NULL)),
  ADD CONSTRAINT "RemoteAppSession_support_key_shape" CHECK ("supportKeySha256" IS NULL OR "supportKeySha256" ~ '^[0-9A-F]{64}$'),
  ADD CONSTRAINT "RemoteAppSession_support_credential_shape" CHECK ("supportCredentialHash" IS NULL OR "supportCredentialHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "RemoteAppSession_support_relay_id" CHECK ("kind" <> 'support' OR "hostDeviceId" ~ '^support_[A-Za-z0-9_-]{22}$'),
  -- New: support sessions never pause (the helped person is there and confirms each action) and are never handed to another agent.
  ADD CONSTRAINT "RemoteAppSession_support_shape" CHECK ("kind" <> 'support' OR ("status" <> 'blocked' AND "executorAgentId" IS NULL)),
  ADD CONSTRAINT "RemoteAppSession_helperLabel" CHECK ("helperLabel" IS NULL OR ("kind" = 'support' AND char_length("helperLabel") BETWEEN 1 AND 60)),
  ADD CONSTRAINT "RemoteAppSession_removal" CHECK (("removal" IS NULL) = ("removalAt" IS NULL) AND ("removal" IS NULL OR ("kind" = 'support' AND "removal" IN ('removed','in_memory','unconfirmed'))));

-- Widened: 'declined' (view-first: the helped person said no to that action on their own screen).
ALTER TABLE "RemoteAppActionLog"
  DROP CONSTRAINT "RemoteAppActionLog_outcome_check",
  ADD CONSTRAINT "RemoteAppActionLog_outcome_check" CHECK ("outcome" IN ('ok','credential_field','not_in_scope','needs_user','fail_closed','declined'));

-- Widened: 'support' passes and leases, which name their session like 'agent' ones do.
ALTER TABLE "AppBridgePass"
  DROP CONSTRAINT "AppBridgePass_purpose_check",
  ADD CONSTRAINT "AppBridgePass_purpose_check" CHECK ("purpose" IN ('session','presence','agent','support')),
  DROP CONSTRAINT "AppBridgePass_agent_binding",
  ADD CONSTRAINT "AppBridgePass_agent_binding" CHECK (("purpose" IN ('agent','support')) = ("remoteAppSessionId" IS NOT NULL));
ALTER TABLE "AppBridgeLease"
  DROP CONSTRAINT "AppBridgeLease_purpose_check",
  ADD CONSTRAINT "AppBridgeLease_purpose_check" CHECK ("purpose" IN ('session','presence','agent','support')),
  DROP CONSTRAINT "AppBridgeLease_agent_binding",
  ADD CONSTRAINT "AppBridgeLease_agent_binding" CHECK (("purpose" IN ('agent','support')) = ("remoteAppSessionId" IS NOT NULL));
