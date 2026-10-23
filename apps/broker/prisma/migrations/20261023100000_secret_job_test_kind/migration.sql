-- The `test` broker job (docs/secrets-epic.md §3.6, "Send a test request" in the BC Remote app) was added to
-- JOB_KINDS in code by #93, but "SecretJob_kind_check" from 20261021090000_secret_broker_phase1 still names the
-- four original kinds, so every test job failed at the insert: the phone saw 503 unavailable and no job was made.
-- The route tests did not catch it because the Postgres roundtrip builds its schema from schema.prisma (no CHECK
-- constraints), not from these migrations.
--
-- ADDITIVE: the constraint only gains a value. No row is touched; dropped and re-added in one statement.
--
-- Order: apply any time; the code that inserts 'test' is already live (revision 00164) and simply works afterwards.
--
-- Rollback (only after deleting any 'test' rows):
--   ALTER TABLE "SecretJob" DROP CONSTRAINT "SecretJob_kind_check",
--     ADD CONSTRAINT "SecretJob_kind_check" CHECK ("kind" IN ('install','update','enrol','lockdown'));
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

ALTER TABLE "SecretJob"
  DROP CONSTRAINT "SecretJob_kind_check",
  ADD CONSTRAINT "SecretJob_kind_check" CHECK ("kind" IN ('install','update','enrol','lockdown','test'));
