-- Lists Phase 3: list templates and the opt-in daily digest (docs/lists.md).
--
-- PURELY ADDITIVE: two new tables. No existing table, column, index, constraint or row is changed.
--
-- "TaskListTemplate": a list a person saved to start new lists from. Only its owner (and the owner's
-- agents) can see or use it. "items" is a JSON array of { title, notes }, 1 to 200 of them; the app
-- also caps titles at 200 characters, notes at 20,000 and the whole template at 100,000 characters
-- of text, and refuses secret-shaped text, the same as for tasks. The size check here is a backstop.
--
-- "ListsPreference": one row per person who has touched their Lists settings. Today that is the
-- daily digest: off (the default) or daily, the local hour to send it, the IANA timezone, and when
-- the last one was claimed for sending (the run claims a row with a conditional update before it
-- sends, so a digest goes out at most once per account per local day even with overlapping runs).
--
-- Both reference "Account" with ON DELETE CASCADE, so deleting an account deletes its templates and
-- its preference. The Prisma schema declares no relation for these (it would mean editing the
-- Account model), so `prisma migrate dev` would report the two foreign keys as drift; like the
-- earlier Lists migrations, this one is hand-written and applied with `prisma migrate deploy`.
--
-- Order: apply this migration BEFORE deploying the app change that uses it, after
-- 20261009210000_task_lists_sharing. The old code never reads these tables, so applying first is
-- safe.
--
-- Rollback: roll the app back first, then (only if wanted; it destroys saved templates and digest
-- settings):
--   DROP TABLE "ListsPreference"; DROP TABLE "TaskListTemplate";

CREATE TABLE "TaskListTemplate" (
  "id" TEXT NOT NULL,
  "ownerAccountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "emoji" TEXT,
  "items" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskListTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskListTemplate_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskListTemplate_name_size" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "TaskListTemplate_emoji_size" CHECK ("emoji" IS NULL OR char_length("emoji") BETWEEN 1 AND 16),
  -- An array of 1 to 200 items. CASE so jsonb_array_length never sees a non-array.
  CONSTRAINT "TaskListTemplate_items_shape" CHECK (CASE WHEN jsonb_typeof("items") = 'array' THEN jsonb_array_length("items") BETWEEN 1 AND 200 ELSE false END),
  CONSTRAINT "TaskListTemplate_items_size" CHECK (octet_length("items"::text) <= 1000000)
);
CREATE INDEX "TaskListTemplate_ownerAccountId_idx" ON "TaskListTemplate"("ownerAccountId");

CREATE TABLE "ListsPreference" (
  "accountId" TEXT NOT NULL,
  "digest" TEXT NOT NULL DEFAULT 'off',
  "digestHour" INTEGER NOT NULL DEFAULT 8,
  "timezone" TEXT,
  "lastDigestAt" TIMESTAMP(3),
  CONSTRAINT "ListsPreference_pkey" PRIMARY KEY ("accountId"),
  CONSTRAINT "ListsPreference_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ListsPreference_digest_check" CHECK ("digest" IN ('off','daily')),
  CONSTRAINT "ListsPreference_digestHour_check" CHECK ("digestHour" BETWEEN 0 AND 23),
  CONSTRAINT "ListsPreference_timezone_size" CHECK ("timezone" IS NULL OR char_length("timezone") BETWEEN 1 AND 64)
);
CREATE INDEX "ListsPreference_digest_idx" ON "ListsPreference"("digest");
