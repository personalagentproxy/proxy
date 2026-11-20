-- When the member pinned their chat with a persona to the top of the Chat page's list. No chat is
-- pinned yet.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "pinnedAt" TIMESTAMP(3);
