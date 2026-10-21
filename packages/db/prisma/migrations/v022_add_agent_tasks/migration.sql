-- What an agent set out to do: it starts a task, naming it and saying what the person asked for,
-- makes its requests for it, and finishes it. Every request and every piece of feedback says which
-- task it was for; the entries from before tasks, and what Personal Agent Proxy did itself, have none.
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "via" "AuditVia" NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTask_orgId_createdAt_idx" ON "AgentTask"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTask_agentId_idx" ON "AgentTask"("agentId");

-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN     "taskId" TEXT;

-- CreateIndex
CREATE INDEX "AuditEntry_taskId_idx" ON "AuditEntry"("taskId");

-- AlterTable
ALTER TABLE "AgentFeedback" ADD COLUMN     "taskId" TEXT;
