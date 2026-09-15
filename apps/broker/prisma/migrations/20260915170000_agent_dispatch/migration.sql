ALTER TABLE "AgentToken" ADD COLUMN "dispatchName" TEXT,
 ADD COLUMN "dispatchEncryptionKey" TEXT, ADD COLUMN "dispatchSigningKey" TEXT;
CREATE TABLE "DispatchTask" (
 "id" TEXT PRIMARY KEY, "senderAgentId" TEXT NOT NULL, "targetAgentId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'queued', "sealed" TEXT NOT NULL, "resultSealed" TEXT,
 "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, "leaseHash" TEXT, "leaseExpiresAt" TIMESTAMP(3),
 CONSTRAINT "DispatchTask_senderAgentId_fkey" FOREIGN KEY ("senderAgentId") REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "DispatchTask_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "DispatchTask_status_check" CHECK ("status" IN ('queued','running','completed','failed','waiting_user','interrupted','cancelled','expired','rejected')),
 CONSTRAINT "DispatchTask_sealed_size" CHECK (octet_length("sealed") BETWEEN 1 AND 131072 AND ("resultSealed" IS NULL OR octet_length("resultSealed") BETWEEN 1 AND 131072))
);
CREATE INDEX "DispatchTask_senderAgentId_createdAt_id_idx" ON "DispatchTask"("senderAgentId", "createdAt", "id");
CREATE INDEX "DispatchTask_targetAgentId_createdAt_id_idx" ON "DispatchTask"("targetAgentId", "createdAt", "id");
