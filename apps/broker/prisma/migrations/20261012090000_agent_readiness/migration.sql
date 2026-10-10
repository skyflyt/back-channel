-- PC readiness for agents (vault design/pc-agent-readiness.md; docs/remote-app-sessions.md, "Setting up a PC"):
-- the Dispatch worker on each PC reports what it can tell (the AppBridge agent-control pipe, claude's sign-in, the
-- agents its remote-app profile accepts) with PUT /api/agents/self/readiness, and the Remote page's "Agents on your
-- PCs" card and bc_remote_machines read it back.
--
-- PURELY ADDITIVE: two new NULLABLE columns on AgentToken and two CHECKs that hold for every existing row (both columns
-- are NULL there). No existing column, index or row is changed.
--   readiness    the last report (JSONB; the app keeps it to the contract's strict shape and at most 8 KiB of JSON);
--   readinessAt  when Back Channel received it (the server's clock, never the PC's).
-- The CHECKs: both are set together, the report is a JSON object, and it stays small. JSONB's text form adds a space
-- after each ':' and ',', so its bound is looser than the app's 8 KiB.
--
-- Order: apply this migration BEFORE deploying the app change that uses it. Prisma selects every scalar column, so the
-- new code fails against a database without these columns (for this table, every bearer-authenticated request). The
-- old code never reads them, so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted):
--   ALTER TABLE "AgentToken" DROP CONSTRAINT "AgentToken_readiness_shape", DROP CONSTRAINT "AgentToken_readiness_at",
--     DROP COLUMN "readiness", DROP COLUMN "readinessAt";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

ALTER TABLE "AgentToken"
  ADD COLUMN "readiness" JSONB,
  ADD COLUMN "readinessAt" TIMESTAMP(3);

ALTER TABLE "AgentToken"
  ADD CONSTRAINT "AgentToken_readiness_at" CHECK (("readiness" IS NULL) = ("readinessAt" IS NULL)),
  ADD CONSTRAINT "AgentToken_readiness_shape" CHECK ("readiness" IS NULL OR (jsonb_typeof("readiness") = 'object' AND octet_length("readiness"::text) <= 16384));
