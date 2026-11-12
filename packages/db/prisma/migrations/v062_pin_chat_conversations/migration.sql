-- A member may pin their own top-level conversation with a persona to the Chat sidebar. Task
-- pinning stays on pinnedAt; this separate column is never set on a sub-agent's thread.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN "chatPinnedAt" TIMESTAMP(3);
