-- How far each member has read their conversation: the `seq` of the last entry they have seen.
-- Every conversation there is counts as read up to its last entry, so nothing said before this
-- turns unread.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "readSeq" INTEGER NOT NULL DEFAULT 0;

UPDATE "AgentThread" AS t
SET "readSeq" = COALESCE((SELECT MAX(e."seq") FROM "AgentEntry" AS e WHERE e."threadId" = t."id"), 0);
