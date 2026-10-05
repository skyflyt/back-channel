-- OAuth for /api/mcp: a scope on agent keys, so a key minted through the OAuth consent flow can be
-- held to less than a key the user handed to an agent they run themselves.
--
-- PURELY ADDITIVE: one new NOT NULL column on AgentToken with a default. No existing column, index or
-- row is changed; every existing key reads as 'full', which is exactly today's behaviour.
--
-- scope = 'full'      every key minted before this, and every key minted by the dashboard, a BCX
--                     exchange code or bc_connect.
-- scope = 'connector' keys minted by POST /api/oauth/token. They cannot mint a dashboard sign-in link
--                     (/api/account/view-token-self, the bc_dashboard_link tool) and cannot use
--                     dispatch. Enforcement is fail-closed: anything other than 'full' is refused.
--
-- Order: apply this migration BEFORE deploying the app change that reads/writes the column (Prisma
-- selects every scalar column, so the new code fails against a database without it — and for this
-- table that means every bearer-authenticated request). The old code ignores the column and its
-- inserts take the default, so applying it first is safe.
--
-- Rollback: ALTER TABLE "AgentToken" DROP COLUMN "scope"; (after rolling the app back).

ALTER TABLE "AgentToken" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'full';
