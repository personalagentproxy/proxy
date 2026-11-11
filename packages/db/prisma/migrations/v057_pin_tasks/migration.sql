-- A member pins a task of their conversation, a sub-agent's thread, to the Chat page's list under
-- its persona.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN "pinnedAt" TIMESTAMP(3);
