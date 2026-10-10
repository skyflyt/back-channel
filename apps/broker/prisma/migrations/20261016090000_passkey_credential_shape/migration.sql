-- Fix: nobody could add a passkey. 20261014090000_account_passkeys gave "AccountPasskey" the CHECK
--   "credentialId" ~ '^[A-Za-z0-9_-]{1,1400}$'
-- and PostgreSQL allows a repetition count of at most 255 in a regular expression. The constraint was accepted
-- when it was created (the table was empty, so the expression was never evaluated), and then every INSERT failed
-- with "invalid regular expression: invalid repetition count(s)". In production the first attempt was 2026-10-10
-- 20:08:12Z: POST /api/account/passkeys/register/verify answered 503 and the account kept no passkey, so with the
-- approval step-up on, no agent session could be approved.
--
-- The same rule, written so PostgreSQL can evaluate it: the length as a length, the alphabet as a regular
-- expression with no counted repetition. base64url, 1 to 1400 characters (a credential id is at most 1023 bytes).
--
-- No row can be affected: every INSERT into "AccountPasskey" failed, so the table is empty wherever the old
-- constraint was in force. Dropping and adding the constraint in one statement leaves no window without it.
--
-- Order: this is a database-only fix. The deployed app needs no change and can stay as it is; apply any time.
--
-- Rollback: none wanted. Restoring the old constraint restores the failure.
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

ALTER TABLE "AccountPasskey"
  DROP CONSTRAINT "AccountPasskey_credential_shape",
  ADD CONSTRAINT "AccountPasskey_credential_shape" CHECK (char_length("credentialId") BETWEEN 1 AND 1400 AND "credentialId" ~ '^[A-Za-z0-9_-]+$');
