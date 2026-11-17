-- A thread's agent can start sub-agents again: each a thread of the same chat, which the chat
-- doesn't list, tied to the thread whose agent started it and the call that started it.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "parentCallId" TEXT,
ADD COLUMN     "subAgentOfId" TEXT;

-- CreateIndex
CREATE INDEX "AgentThread_subAgentOfId_idx" ON "AgentThread"("subAgentOfId");
