-- Lists Phase 2: sharing lists with friends (docs/lists.md; design approved 2026-10-09).
--
-- PURELY ADDITIVE: one new column with a default on "TaskListMember", and four new tables. No
-- existing column, index, constraint or row is changed or removed.
--
-- A member other than the owner counts only while they and the owner are mutual friends (both
-- "TrustedPeer" rows). The app checks that on every request, so access fails closed even if the
-- cleanup that runs when trust is revoked never ran. Nothing here references "TrustedPeer".
--
-- Same no-FK attribution rule as 20261009200000_task_lists: who OK'd, mentioned, reacted or joined
-- is a plain column, so revoking an agent or a person leaving never deletes the record. Every new
-- row cascades with its task, entry or list.
--
-- Order: apply this migration BEFORE deploying the app change that uses it, and after
-- 20261009200000_task_lists. The old code never reads the new column or tables, and the column's
-- default ('off') matches what the old code implies, so applying first is safe.
--
-- Rollback: roll the app back first, then (only if wanted; it destroys OKs, mentions, reactions,
-- list activity and nudge settings):
--   DROP TABLE "TaskListEvent"; DROP TABLE "TaskReaction"; DROP TABLE "TaskMention";
--   DROP TABLE "TaskAgentOk"; ALTER TABLE "TaskListMember" DROP COLUMN "notify";

ALTER TABLE "TaskListMember" ADD COLUMN "notify" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "TaskListMember" ADD CONSTRAINT "TaskListMember_notify_check" CHECK ("notify" IN ('off','mentions_reviews'));

CREATE TABLE "TaskAgentOk" (
  "taskId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "via" TEXT NOT NULL,
  "viaAgentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskAgentOk_pkey" PRIMARY KEY ("taskId", "accountId"),
  CONSTRAINT "TaskAgentOk_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TaskItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskAgentOk_via_check" CHECK ("via" IN ('web','user_in_chat','list_setting')),
  -- A chat OK always names the agent that recorded it.
  CONSTRAINT "TaskAgentOk_chat_agent" CHECK ("via" <> 'user_in_chat' OR "viaAgentId" IS NOT NULL)
);
CREATE INDEX "TaskAgentOk_accountId_idx" ON "TaskAgentOk"("accountId");

CREATE TABLE "TaskMention" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "agentId" TEXT,
  "seenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskMention_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskMention_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "TaskEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskMention_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TaskItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskMention_accountId_seenAt_idx" ON "TaskMention"("accountId", "seenAt");
CREATE INDEX "TaskMention_taskId_idx" ON "TaskMention"("taskId");
CREATE INDEX "TaskMention_entryId_idx" ON "TaskMention"("entryId");
-- One mention per person (or agent) per entry.
CREATE UNIQUE INDEX "TaskMention_entry_target_key" ON "TaskMention"("entryId", "accountId", COALESCE("agentId", ''));

CREATE TABLE "TaskReaction" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "agentId" TEXT,
  "emoji" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskReaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskReaction_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TaskItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskReaction_emoji_check" CHECK ("emoji" IN ('👍','🎉','🙏','✅'))
);
CREATE INDEX "TaskReaction_taskId_idx" ON "TaskReaction"("taskId");
-- A reaction toggles: each person, and each of their agents, gives each emoji at most once per task.
CREATE UNIQUE INDEX "TaskReaction_one_each_key" ON "TaskReaction"("taskId", "accountId", COALESCE("agentId", ''), "emoji");

CREATE TABLE "TaskListEvent" (
  "id" TEXT NOT NULL,
  "listId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "actorAccountId" TEXT NOT NULL,
  "subjectAccountId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskListEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskListEvent_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskListEvent_eventType_check" CHECK ("eventType" IN ('member_added','member_left','member_removed'))
);
CREATE INDEX "TaskListEvent_listId_createdAt_idx" ON "TaskListEvent"("listId", "createdAt");
