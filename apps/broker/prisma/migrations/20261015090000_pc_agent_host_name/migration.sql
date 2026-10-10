-- Which registered PC a Back Channel worker runs on (docs/remote-app-sessions.md, "Setting up a PC"). A worker's
-- readiness report names the computer it runs on (appbridge.hostName: AppBridge's agent-control hello, the Windows
-- computer name), and Back Channel matched that only against the PC's label, the name the person typed when they
-- registered it. A PC registered as "Desktop" whose computer is "JRR-IT-MZ013M7D" therefore never matched: its
-- readiness stayed Unknown, bc_remote_machines listed no agent on it, and it never got desktop-scope sessions.
-- The person now confirms the computer name for a PC on the Remote page, stored here.
--
-- PURELY ADDITIVE: one new NULLABLE column on AppBridgeDevice and a CHECK that holds for every existing row (NULL
-- there). No existing column, index or row is changed.
--   agentHostName  the computer name the person confirmed for this PC (printable, 1 to 80 characters; the app
--                  checks it is one a worker of the account reported).
--
-- Order: apply this migration BEFORE deploying the app change that uses it. Prisma selects every scalar column, so
-- the new code fails against a database without it (every AppBridge device read). The old code never reads it, so
-- applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted):
--   ALTER TABLE "AppBridgeDevice" DROP CONSTRAINT "AppBridgeDevice_agentHostName_len", DROP COLUMN "agentHostName";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

ALTER TABLE "AppBridgeDevice" ADD COLUMN "agentHostName" TEXT;

ALTER TABLE "AppBridgeDevice"
  ADD CONSTRAINT "AppBridgeDevice_agentHostName_len" CHECK ("agentHostName" IS NULL OR char_length("agentHostName") BETWEEN 1 AND 80);
