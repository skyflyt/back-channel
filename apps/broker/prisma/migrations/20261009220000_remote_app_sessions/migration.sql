-- Remote app sessions: an agent uses an app on one of its person's own PCs through Back Channel Remote
-- (docs/remote-app-sessions.md; design "Phase A", decisions taken 2026-10-09).
--
-- ADDITIVE, with one deliberate widening:
--   - two new tables, RemoteAppSession and RemoteAppActionLog, with their indexes and CHECKs;
--   - one new nullable column, "remoteAppSessionId", on AppBridgePass and on AppBridgeLease, plus an index;
--   - the purpose CHECK on AppBridgePass and AppBridgeLease WIDENED from ('session','presence') to
--     ('session','presence','agent'). Every existing row satisfies the wider check, so nothing is rewritten.
-- No existing row, column or index is changed or dropped.
--
-- What is stored is metadata only: which agent asked, for which PC, which apps (by name), for how long,
-- the goal and task it named, who approved it, and a log of fixed action kinds with a bounded control
-- name. Never what was on the screen, what was typed, or a screenshot: evidence stays on the PC and
-- evidenceRef is only a pointer into the PC's own store.
--
-- The binding ids (hostDeviceId, agentTokenId, executorAgentId, listTaskId, RemoteAppActionLog.sessionId)
-- deliberately carry NO foreign key: removing a PC or an agent ends a session, and must never delete the
-- record of what happened. accountId carries none either (no back-relation on Account): delete these rows
-- by accountId if an account is ever deleted by hand.
--
-- Order: apply this migration BEFORE deploying the app change that uses it. The old code never reads the new
-- tables or column and never writes 'agent', so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted; it destroys the session history):
--   DELETE FROM "AppBridgeLease" WHERE "purpose" = 'agent';
--   DELETE FROM "AppBridgePass" WHERE "purpose" = 'agent';
--   ALTER TABLE "AppBridgeLease" DROP CONSTRAINT "AppBridgeLease_agent_binding", DROP CONSTRAINT "AppBridgeLease_purpose_check",
--     ADD CONSTRAINT "AppBridgeLease_purpose_check" CHECK ("purpose" IN ('session','presence'));
--   ALTER TABLE "AppBridgePass" DROP CONSTRAINT "AppBridgePass_agent_binding", DROP CONSTRAINT "AppBridgePass_purpose_check",
--     ADD CONSTRAINT "AppBridgePass_purpose_check" CHECK ("purpose" IN ('session','presence'));
--   DROP INDEX "AppBridgeLease_remoteAppSessionId_idx";
--   ALTER TABLE "AppBridgeLease" DROP COLUMN "remoteAppSessionId";
--   ALTER TABLE "AppBridgePass" DROP COLUMN "remoteAppSessionId";
--   DROP TABLE "RemoteAppActionLog"; DROP TABLE "RemoteAppSession";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL
-- backup, check `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

CREATE TABLE "RemoteAppSession" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'agent',
  "hostDeviceId" TEXT NOT NULL,
  "agentTokenId" TEXT NOT NULL,
  "executorAgentId" TEXT,
  "listTaskId" TEXT,
  "goal" TEXT NOT NULL,
  "appAllowList" TEXT[],
  "status" TEXT NOT NULL DEFAULT 'awaiting_consent',
  "consentBy" TEXT,
  "consentVia" TEXT,
  "minutes" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "endReason" TEXT,
  "summary" TEXT,
  "evidenceRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RemoteAppSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RemoteAppSession_kind_check" CHECK ("kind" IN ('agent','support')),
  CONSTRAINT "RemoteAppSession_status_check" CHECK ("status" IN ('awaiting_consent','active','blocked','ended','denied','lapsed')),
  CONSTRAINT "RemoteAppSession_endReason_check" CHECK ("endReason" IS NULL OR "endReason" IN ('done','user_stop','host_stop','agent_stop','lapsed','fail_closed','revoked')),
  -- An ended session always says why; nothing else carries a reason.
  CONSTRAINT "RemoteAppSession_endReason_when_ended" CHECK (("status" = 'ended') = ("endReason" IS NOT NULL)),
  -- v1: a person approves in the dashboard, and nowhere else.
  CONSTRAINT "RemoteAppSession_consentVia_check" CHECK ("consentVia" IS NULL OR "consentVia" IN ('web')),
  CONSTRAINT "RemoteAppSession_minutes_check" CHECK ("minutes" BETWEEN 1 AND 60),
  CONSTRAINT "RemoteAppSession_goal_size" CHECK (char_length("goal") BETWEEN 1 AND 500),
  CONSTRAINT "RemoteAppSession_apps_size" CHECK ("appAllowList" IS NOT NULL AND cardinality("appAllowList") BETWEEN 1 AND 8),
  CONSTRAINT "RemoteAppSession_summary_size" CHECK ("summary" IS NULL OR char_length("summary") <= 2000),
  CONSTRAINT "RemoteAppSession_evidenceRef_size" CHECK ("evidenceRef" IS NULL OR char_length("evidenceRef") <= 128),
  -- A running session has a start and an end, and never more than 60 minutes between them.
  CONSTRAINT "RemoteAppSession_running_window" CHECK ("status" NOT IN ('active','blocked') OR ("startedAt" IS NOT NULL AND "expiresAt" IS NOT NULL)),
  CONSTRAINT "RemoteAppSession_window_cap" CHECK ("expiresAt" IS NULL OR ("startedAt" IS NOT NULL AND "expiresAt" <= "startedAt" + INTERVAL '60 minutes'))
);
CREATE INDEX "RemoteAppSession_accountId_status_idx" ON "RemoteAppSession"("accountId", "status");
CREATE INDEX "RemoteAppSession_agentTokenId_idx" ON "RemoteAppSession"("agentTokenId");
CREATE INDEX "RemoteAppSession_hostDeviceId_status_idx" ON "RemoteAppSession"("hostDeviceId", "status");

CREATE TABLE "RemoteAppActionLog" (
  "id" BIGSERIAL NOT NULL,
  "sessionId" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "action" TEXT NOT NULL,
  "target" TEXT,
  "outcome" TEXT NOT NULL,
  "evidenceRef" TEXT,
  CONSTRAINT "RemoteAppActionLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RemoteAppActionLog_action_check" CHECK ("action" IN ('open','observe','invoke','set_value','toggle','select','scroll','key','screenshot','blocked')),
  CONSTRAINT "RemoteAppActionLog_outcome_check" CHECK ("outcome" IN ('ok','credential_field','not_in_scope','needs_user','fail_closed')),
  CONSTRAINT "RemoteAppActionLog_target_size" CHECK ("target" IS NULL OR char_length("target") BETWEEN 1 AND 120),
  CONSTRAINT "RemoteAppActionLog_evidenceRef_size" CHECK ("evidenceRef" IS NULL OR char_length("evidenceRef") BETWEEN 1 AND 128)
);
CREATE INDEX "RemoteAppActionLog_sessionId_at_idx" ON "RemoteAppActionLog"("sessionId", "at");

-- The PC's "agent" relay pass and lease name the session they belong to.
ALTER TABLE "AppBridgePass" ADD COLUMN "remoteAppSessionId" TEXT;
ALTER TABLE "AppBridgeLease" ADD COLUMN "remoteAppSessionId" TEXT;
CREATE INDEX "AppBridgeLease_remoteAppSessionId_idx" ON "AppBridgeLease"("remoteAppSessionId");

-- Widen the purpose checks (one statement each, so there is no moment without a check), and bind
-- 'agent' to a session: an agent pass or lease always names one, nothing else ever does.
ALTER TABLE "AppBridgePass"
  DROP CONSTRAINT IF EXISTS "AppBridgePass_purpose_check",
  ADD CONSTRAINT "AppBridgePass_purpose_check" CHECK ("purpose" IN ('session','presence','agent')),
  ADD CONSTRAINT "AppBridgePass_agent_binding" CHECK (("purpose" = 'agent') = ("remoteAppSessionId" IS NOT NULL));
ALTER TABLE "AppBridgeLease"
  DROP CONSTRAINT IF EXISTS "AppBridgeLease_purpose_check",
  ADD CONSTRAINT "AppBridgeLease_purpose_check" CHECK ("purpose" IN ('session','presence','agent')),
  ADD CONSTRAINT "AppBridgeLease_agent_binding" CHECK (("purpose" = 'agent') = ("remoteAppSessionId" IS NOT NULL));
