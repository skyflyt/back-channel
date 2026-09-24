-- SEC H1, phase (c): clear the plaintext Account.apiKey wherever its hashed AgentToken exists.
--
-- State of prod before this migration (read-only inspection, 2026-09-24):
--   - 20 accounts held a plaintext apiKey. 15 already had an AgentToken whose keyHash is that
--     key's SHA-256; the remaining 5 were hashed the same day, inside one transaction, after
--     Cloud SQL backup 1790261265530. Result: 20/20 covered (18 live tokens, 2 revoked).
--   - No plaintext key had been used through the legacy fallback in the last 30 days.
--   - 20260703221500_h1_apikey_hash_backfill was then marked applied (its effect is complete).
--
-- Order: deploy the app change that removes the plaintext fallback in getAuthContext FIRST,
-- then apply this migration. Until it runs, a code rollback still authenticates as before.
--
-- Safe:
--   - Only rows whose key is verified hashed in AgentToken (live or revoked) are cleared, so no
--     key that authenticates today stops authenticating; a revoked key stays dead.
--   - Uses Postgres's built-in sha256() (PG 11+), not pgcrypto (not installed in prod).
--     encode(sha256(convert_to(k,'UTF8')),'hex') equals the app's hashToken(k).
--   - Idempotent: a second run matches no rows.
--   - Nothing is dropped. Dropping Account.apiKey / apiKeyLastUsedAt is a later migration, after
--     e2e-keymirror.mjs and smoke-friends.mjs stop writing the column.
--
-- LOUD NOTICE FOR SKYLAR: touches LIVE prod data. Take an on-demand Cloud SQL backup first.
-- Prod migration tracking exists since 2026-09-24, so `npx prisma migrate deploy` through the
-- Cloud SQL proxy applies exactly this migration.

UPDATE "Account" AS a
SET "apiKey" = NULL
WHERE a."apiKey" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "AgentToken" t
    WHERE t."accountId" = a."id"
      AND t."keyHash" = encode(sha256(convert_to(a."apiKey", 'UTF8')), 'hex')
  );
