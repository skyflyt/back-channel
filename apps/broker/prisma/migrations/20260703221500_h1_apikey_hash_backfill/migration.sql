-- SEC H1 backfill — hash any remaining plaintext Account.apiKey values into
-- AgentToken rows, so no live account depends on the plaintext column for auth.
--
-- ============================================================================
-- LOUD NOTICE FOR SKYLAR: this migration touches the LIVE production database.
-- It must be run by hand with a real prod DB connection, e.g.:
--
--     cd apps/broker
--     DATABASE_URL="postgresql://backchannel-app:<password>@<cloud-sql-proxy-host>/backchannel" \
--       npx prisma migrate deploy
--
-- There is no CI/CD step that runs Prisma migrations automatically (checked
-- .github/workflows/*.yml and apps/broker/cloudbuild.yaml — neither invokes
-- `prisma migrate deploy`; DEPLOY.md documents running it by hand against
-- Cloud SQL). Do not skip reviewing this file before running it.
-- ============================================================================
--
-- What it does:
--   For every Account row where "apiKey" IS NOT NULL and no live (non-revoked)
--   AgentToken named 'Original' exists yet for that account, compute
--   sha256(apiKey) and insert an AgentToken row carrying that hash — so the
--   account's existing bc_ key keeps authenticating via the canonical
--   AgentToken.keyHash lookup path in getAuthContext() (apps/broker/src/lib/auth.ts),
--   not the plaintext-compare fallback.
--
-- Why this is safe / idempotent:
--   - The INSERT ... SELECT only targets accounts with apiKey IS NOT NULL
--     and no existing live 'Original' AgentToken (NOT EXISTS guard), so running
--     this migration twice is a no-op the second time.
--   - It computes the hash from the EXISTING plaintext value already in prod —
--     it does not invent a new key or rotate anything, so no live agent's
--     current bc_ key stops working.
--   - AgentToken.keyHash has a UNIQUE constraint; ON CONFLICT DO NOTHING makes
--     a concurrent/duplicate run harmless rather than erroring.
--   - This migration does NOT drop or null out Account.apiKey. The plaintext
--     stays in place (still readable by the legacy fallback in getAuthContext)
--     until Skylar confirms in prod that this backfill is complete AND that
--     app code no longer needs the fallback — that column drop is a SEPARATE,
--     LATER migration, intentionally not included here. See the "NOT included"
--     note at the bottom of this file.
--
-- Hashing scheme match (verified against apps/broker/src/lib/auth.ts hashToken):
--   hashToken(raw) = createHash("sha256").update(raw).digest("hex")
--   This is a bare SHA-256 of the raw UTF-8 string, hex-encoded, with no salt,
--   prefix, or KDF stretching — so it is exactly reproducible in pure SQL via
--   pgcrypto's digest()+encode(), no application-side backfill script needed.
--
-- Requires the pgcrypto extension for digest(). Cloud SQL Postgres ships it;
-- this just ensures it's enabled (no-op if already present, requires either
-- superuser or a role with CREATE on the database — the same role that will
-- run `prisma migrate deploy` should already have this, since Cloud SQL's
-- default app user is typically granted it at instance setup).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO "AgentToken" ("id", "accountId", "keyHash", "name", "runtimeType", "createdAt")
SELECT
  gen_random_uuid()::text,
  a."id",
  encode(digest(a."apiKey", 'sha256'), 'hex'),
  'Original',
  'other',
  now()
FROM "Account" a
WHERE a."apiKey" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "AgentToken" t
    WHERE t."accountId" = a."id"
      AND t."name" = 'Original'
      AND t."revokedAt" IS NULL
  )
ON CONFLICT ("keyHash") DO NOTHING;

-- ============================================================================
-- NOT included in this migration (by design — see prisma/schema.prisma H1
-- comments and the PR description for the full phased plan):
--
--   Phase (a) [THIS PR, code only]: stop writing plaintext apiKey; read path
--     tries AgentToken.keyHash first, falls back to plaintext compare only if
--     no hash match is found yet.
--   Phase (b) [THIS migration]: hash any remaining plaintext keys into
--     AgentToken rows, so the fallback in (a) becomes reachable only for
--     accounts this backfill didn't cover (there should be none, once this
--     runs clean in prod).
--   Phase (c) [LATER, NOT in this migration]: once Skylar has confirmed in
--     prod that (b) ran successfully and that no auth requests are still
--     hitting the plaintext-fallback path (e.g. via a log/metric check on the
--     "legacy fallback" branch in getAuthContext), a follow-up migration can:
--       ALTER TABLE "Account" DROP COLUMN "apiKey";
--       ALTER TABLE "Account" DROP COLUMN "apiKeyLastUsedAt"; -- optional, or repoint to AgentToken.lastUsedAt
--     and the code fallback + this backfill migration's guard can be deleted.
--     DO NOT run that drop as part of this migration — it is destructive and
--     must wait for confirmed-clean backfill telemetry in prod.
-- ============================================================================
