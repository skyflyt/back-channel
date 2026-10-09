ALTER TABLE "AgentToken" ADD COLUMN "mailboxEncryptionKey" TEXT, ADD COLUMN "mailboxSigningKey" TEXT;
CREATE TABLE "AgentMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "senderAgentId" TEXT NOT NULL REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "targetAgentId" TEXT NOT NULL REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sealed" TEXT NOT NULL,
  "senderSealed" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "readAt" TIMESTAMP(3)
);
CREATE INDEX "AgentMessage_targetAgentId_readAt_expiresAt_idx" ON "AgentMessage"("targetAgentId", "readAt", "expiresAt");
CREATE INDEX "AgentMessage_senderAgentId_createdAt_id_idx" ON "AgentMessage"("senderAgentId", "createdAt", "id");
CREATE INDEX "AgentMessage_targetAgentId_createdAt_id_idx" ON "AgentMessage"("targetAgentId", "createdAt", "id");
