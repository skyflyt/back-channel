-- The support relay path (vault design/support-relay-contract.md, "Remote support relay path, contract v1", section 2.3):
-- the issuer connector's "support-client" relay pass and lease, its pin on the support session, and the per-session
-- executor secret shared by Phase A (agent-control v1.1) and Phase B. docs/remote-support.md, docs/remote-app-sessions.md.
--
-- ADDITIVE, with deliberate WIDENINGS of four existing CHECKs (each one dropped and re-added in a single ALTER TABLE
-- statement, so there is no moment without a check):
--   - four new NULLABLE columns on RemoteAppSession: supportClientDeviceId, supportClientKeySha256 (the issuer
--     connector, pinned at its first support-client pass), executorSecretHash (sha256 of the executor secret; the raw
--     value is never stored) and executorSecretIssuedAt (when it was last handed out); one new index on
--     supportClientKeySha256 (the redeem flood allow-list reads it);
--   - NEW RemoteAppSession CHECKs: only a support session has an issuer pin, the pin is a device and a key together,
--     the key is uppercase hex, the hash is lowercase hex, and an issued secret always has a hash;
--   - AppBridgePass and AppBridgeLease purpose WIDENED: also 'support-client';
--   - AppBridgePass and AppBridgeLease session binding ("_agent_binding") WIDENED: a 'support-client' pass or lease
--     names its session, like 'agent' and 'support' ones (without this widening every support-client row would
--     violate it);
--   - NEW AppBridgePass and AppBridgeLease CHECKs: a 'support-client' pass or lease names the issuer's device and no
--     enrollment.
-- No existing row, column or index is changed or dropped, and every existing row satisfies every new or widened check
-- (no row has purpose 'support-client' or any of the new columns set). Existing sessions keep a NULL executorSecretHash:
-- that is exactly what marks a v1 session, whose PC asks for no executor secret (back-compatibility).
--
-- Order: apply this migration BEFORE deploying the app change that uses it. The old code never reads the new columns
-- and never writes 'support-client', so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted):
--   DELETE FROM "AppBridgeLease" WHERE "purpose" = 'support-client';
--   DELETE FROM "AppBridgePass" WHERE "purpose" = 'support-client';
--   ALTER TABLE "AppBridgeLease" DROP CONSTRAINT "AppBridgeLease_support_client_binding",
--     DROP CONSTRAINT "AppBridgeLease_purpose_check", ADD CONSTRAINT "AppBridgeLease_purpose_check" CHECK ("purpose" IN ('session','presence','agent','support')),
--     DROP CONSTRAINT "AppBridgeLease_agent_binding", ADD CONSTRAINT "AppBridgeLease_agent_binding" CHECK (("purpose" IN ('agent','support')) = ("remoteAppSessionId" IS NOT NULL));
--   (the same four lines for "AppBridgePass")
--   ALTER TABLE "RemoteAppSession" DROP CONSTRAINT "RemoteAppSession_support_client_shape", DROP CONSTRAINT "RemoteAppSession_support_client_pin",
--     DROP CONSTRAINT "RemoteAppSession_support_client_key_shape", DROP CONSTRAINT "RemoteAppSession_executorSecret_shape",
--     DROP CONSTRAINT "RemoteAppSession_executorSecret_issued";
--   DROP INDEX "RemoteAppSession_supportClientKeySha256_idx";
--   ALTER TABLE "RemoteAppSession" DROP COLUMN "supportClientDeviceId", DROP COLUMN "supportClientKeySha256",
--     DROP COLUMN "executorSecretHash", DROP COLUMN "executorSecretIssuedAt";
--
-- Before applying to prod, follow the notice in 20260924030000_appbridge_remote_access: take a Cloud SQL backup, check
-- `prisma migrate status`, and apply by hand through the Cloud SQL proxy.

ALTER TABLE "RemoteAppSession"
  ADD COLUMN "supportClientDeviceId" TEXT,
  ADD COLUMN "supportClientKeySha256" TEXT,
  ADD COLUMN "executorSecretHash" TEXT,
  ADD COLUMN "executorSecretIssuedAt" TIMESTAMP(3);
CREATE INDEX "RemoteAppSession_supportClientKeySha256_idx" ON "RemoteAppSession"("supportClientKeySha256");

ALTER TABLE "RemoteAppSession"
  -- Only a support session has an issuer connector.
  ADD CONSTRAINT "RemoteAppSession_support_client_shape" CHECK ("kind" = 'support' OR ("supportClientKeySha256" IS NULL AND "supportClientDeviceId" IS NULL)),
  -- The pin is one device and its key, set together (at the first support-client pass), never half.
  ADD CONSTRAINT "RemoteAppSession_support_client_pin" CHECK (("supportClientKeySha256" IS NULL) = ("supportClientDeviceId" IS NULL)),
  ADD CONSTRAINT "RemoteAppSession_support_client_key_shape" CHECK ("supportClientKeySha256" IS NULL OR "supportClientKeySha256" ~ '^[0-9A-F]{64}$'),
  -- A sha256 hex digest, never anything readable.
  ADD CONSTRAINT "RemoteAppSession_executorSecret_shape" CHECK ("executorSecretHash" IS NULL OR "executorSecretHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "RemoteAppSession_executorSecret_issued" CHECK ("executorSecretIssuedAt" IS NULL OR "executorSecretHash" IS NOT NULL);

-- Widened: 'support-client' passes and leases, which name their session like 'agent' and 'support' ones do, and the
-- issuer's device (never an enrollment: the helper is not a paired PC).
ALTER TABLE "AppBridgePass"
  DROP CONSTRAINT "AppBridgePass_purpose_check",
  ADD CONSTRAINT "AppBridgePass_purpose_check" CHECK ("purpose" IN ('session','presence','agent','support','support-client')),
  DROP CONSTRAINT "AppBridgePass_agent_binding",
  ADD CONSTRAINT "AppBridgePass_agent_binding" CHECK (("purpose" IN ('agent','support','support-client')) = ("remoteAppSessionId" IS NOT NULL)),
  ADD CONSTRAINT "AppBridgePass_support_client_binding" CHECK ("purpose" <> 'support-client' OR ("remoteDeviceId" IS NOT NULL AND "enrollmentId" IS NULL));
ALTER TABLE "AppBridgeLease"
  DROP CONSTRAINT "AppBridgeLease_purpose_check",
  ADD CONSTRAINT "AppBridgeLease_purpose_check" CHECK ("purpose" IN ('session','presence','agent','support','support-client')),
  DROP CONSTRAINT "AppBridgeLease_agent_binding",
  ADD CONSTRAINT "AppBridgeLease_agent_binding" CHECK (("purpose" IN ('agent','support','support-client')) = ("remoteAppSessionId" IS NOT NULL)),
  ADD CONSTRAINT "AppBridgeLease_support_client_binding" CHECK ("purpose" <> 'support-client' OR ("remoteDeviceId" IS NOT NULL AND "enrollmentId" IS NULL));
