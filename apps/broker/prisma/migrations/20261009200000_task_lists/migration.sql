-- Lists: task lists for people and their agents (docs/lists.md; design approved 2026-10-09).
--
-- PURELY ADDITIVE: five new tables. No existing table, column, index or row is changed.
--
-- List content (names, task titles, notes, comments) is stored readable by the broker ON PURPOSE:
-- lists must work from every host, and remote MCP connectors (claude.ai, ChatGPT) cannot decrypt.
-- /privacy says so in the same release. Agent-to-agent messages stay end-to-end encrypted.
--
-- Attribution columns (createdBy*, claim*, completedBy*, reviewer*, author*, and
-- TaskListAgentGrant.agentTokenId) deliberately carry NO foreign key: revoking an agent or a person
-- leaving must never cascade-delete the record of what they did. Ownership and membership do cascade
-- with the account, and tasks and entries cascade with their list.
--
-- Order: apply this migration BEFORE deploying the app change that uses these tables. The old code
-- never touches them, so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted, and it destroys list data):
--   DROP TABLE "TaskEntry"; DROP TABLE "TaskItem"; DROP TABLE "TaskListAgentGrant";
--   DROP TABLE "TaskListMember"; DROP TABLE "TaskList";

CREATE TABLE "TaskList" (
  "id" TEXT NOT NULL,
  "ownerAccountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "emoji" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskList_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskList_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskList_name_size" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "TaskList_emoji_size" CHECK ("emoji" IS NULL OR char_length("emoji") BETWEEN 1 AND 16)
);
CREATE INDEX "TaskList_ownerAccountId_idx" ON "TaskList"("ownerAccountId");

CREATE TABLE "TaskListMember" (
  "listId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "agentsTakeFrom" TEXT NOT NULL DEFAULT 'me',
  "addedByAccountId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskListMember_pkey" PRIMARY KEY ("listId", "accountId"),
  CONSTRAINT "TaskListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskListMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskListMember_role_check" CHECK ("role" IN ('owner','member')),
  CONSTRAINT "TaskListMember_agentsTakeFrom_check" CHECK ("agentsTakeFrom" IN ('me','anyone'))
);
CREATE INDEX "TaskListMember_accountId_idx" ON "TaskListMember"("accountId");

CREATE TABLE "TaskListAgentGrant" (
  "listId" TEXT NOT NULL,
  "agentTokenId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "access" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskListAgentGrant_pkey" PRIMARY KEY ("listId", "agentTokenId"),
  CONSTRAINT "TaskListAgentGrant_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskListAgentGrant_access_check" CHECK ("access" IN ('view','work'))
);
CREATE INDEX "TaskListAgentGrant_agentTokenId_idx" ON "TaskListAgentGrant"("agentTokenId");

CREATE TABLE "TaskItem" (
  "id" TEXT NOT NULL,
  "listId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'open',
  "position" DOUBLE PRECISION NOT NULL,
  "dueAt" TIMESTAMP(3),
  "createdByAccountId" TEXT NOT NULL,
  "createdByAgentId" TEXT,
  "assigneeAccountId" TEXT,
  "assigneeAgents" BOOLEAN NOT NULL DEFAULT false,
  "assigneeAgentId" TEXT,
  "agentSeenAt" TIMESTAMP(3),
  "claimAccountId" TEXT,
  "claimAgentId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "claimExpiresAt" TIMESTAMP(3),
  "reviewerAccountId" TEXT,
  "completedAt" TIMESTAMP(3),
  "completedByAccountId" TEXT,
  "completedByAgentId" TEXT,
  "summary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskItem_status_check" CHECK ("status" IN ('open','in_progress','blocked','needs_review','done','dropped')),
  CONSTRAINT "TaskItem_title_size" CHECK (char_length("title") BETWEEN 1 AND 200),
  CONSTRAINT "TaskItem_notes_size" CHECK (char_length("notes") <= 20000),
  CONSTRAINT "TaskItem_summary_size" CHECK ("summary" IS NULL OR char_length("summary") <= 8000),
  -- An agent claim always lapses; a person's claim never does.
  CONSTRAINT "TaskItem_agent_claim_expires" CHECK ("claimAgentId" IS NULL OR "claimExpiresAt" IS NOT NULL)
);
CREATE INDEX "TaskItem_listId_status_position_idx" ON "TaskItem"("listId", "status", "position");
CREATE INDEX "TaskItem_assigneeAccountId_status_idx" ON "TaskItem"("assigneeAccountId", "status");
CREATE INDEX "TaskItem_claimAgentId_idx" ON "TaskItem"("claimAgentId");
CREATE INDEX "TaskItem_updatedAt_idx" ON "TaskItem"("updatedAt");

CREATE TABLE "TaskEntry" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "authorAccountId" TEXT NOT NULL,
  "authorAgentId" TEXT,
  "body" TEXT NOT NULL,
  "eventType" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TaskItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskEntry_kind_check" CHECK ("kind" IN ('comment','progress','event')),
  CONSTRAINT "TaskEntry_body_size" CHECK (char_length("body") BETWEEN 1 AND 8000)
);
CREATE INDEX "TaskEntry_taskId_createdAt_idx" ON "TaskEntry"("taskId", "createdAt");
