-- Agent sessions use the full desktop (vault design/agent-desktop-scope.md, decided by Skylar 2026-10-10: "Always,
-- wherever agent control is on"; docs/remote-app-sessions.md, "Desktop scope"). Every new agent session may use the
-- whole PC under the rails; its app names become informational ("expects to use"), and may be none at all.
--
-- ADDITIVE, with one deliberate WIDENING of an existing CHECK (dropped and re-added in a single ALTER TABLE statement,
-- so there is no moment without a check):
--   - one new column on RemoteAppSession, "scope": 'apps' (the session's apps only, as before) or 'desktop' (the whole
--     PC). NOT NULL DEFAULT 'apps', so every existing row, agent or support, stays exactly what it was: an apps-scope
--     session. The app sets 'desktop' on every new agent session; it never writes 'desktop' on a support session;
--   - NEW CHECK "RemoteAppSession_scope_check": scope is 'apps' or 'desktop', and only an agent session is 'desktop';
--   - "RemoteAppSession_apps_size" WIDENED: an agent session in desktop scope has 0 to 8 app names (the apps it
--     expects to use); an agent session in apps scope still has 1 to 8 and a support session still has none,
--     exactly as before.
-- No existing row, column or index is changed or dropped, and every existing row satisfies the new and widened checks
-- (every row gets scope 'apps', and the apps-scope branch of apps_size is the old check unchanged).
--
-- Order: apply this migration BEFORE deploying the app change that uses it. Prisma selects every scalar column, so the
-- new code fails against a database without "scope"; the old code never reads it, and every row the old code creates
-- gets the default 'apps' with 1 to 8 apps, which both checks accept. So applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted; it destroys the history of desktop sessions that named no
-- apps, which the old check can't hold):
--   DELETE FROM "RemoteAppActionLog" WHERE "sessionId" IN (SELECT "id" FROM "RemoteAppSession" WHERE "scope" = 'desktop' AND cardinality("appAllowList") = 0);
--   DELETE FROM "RemoteAppSession" WHERE "scope" = 'desktop' AND cardinality("appAllowList") = 0;
--   ALTER TABLE "RemoteAppSession" DROP CONSTRAINT "RemoteAppSession_apps_size",
--     ADD CONSTRAINT "RemoteAppSession_apps_size" CHECK ("appAllowList" IS NOT NULL AND (("kind" = 'agent' AND cardinality("appAllowList") BETWEEN 1 AND 8) OR ("kind" = 'support' AND cardinality("appAllowList") = 0)));
--   ALTER TABLE "RemoteAppSession" DROP CONSTRAINT "RemoteAppSession_scope_check", DROP COLUMN "scope";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

ALTER TABLE "RemoteAppSession"
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'apps';

ALTER TABLE "RemoteAppSession"
  -- Two scopes, and the whole PC is for an agent session only (a support session is always its helper's apps).
  ADD CONSTRAINT "RemoteAppSession_scope_check" CHECK ("scope" IN ('apps','desktop') AND ("scope" = 'apps' OR "kind" = 'agent')),
  -- Widened: a desktop-scope agent session may name no apps at all (they are only what it expects to use).
  DROP CONSTRAINT "RemoteAppSession_apps_size",
  ADD CONSTRAINT "RemoteAppSession_apps_size" CHECK ("appAllowList" IS NOT NULL AND (
    ("kind" = 'agent' AND "scope" = 'apps' AND cardinality("appAllowList") BETWEEN 1 AND 8) OR
    ("kind" = 'agent' AND "scope" = 'desktop' AND cardinality("appAllowList") BETWEEN 0 AND 8) OR
    ("kind" = 'support' AND cardinality("appAllowList") = 0)));
