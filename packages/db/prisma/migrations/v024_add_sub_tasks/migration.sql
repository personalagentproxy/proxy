-- Sub-tasks: a task an agent hands part of to another agent, or to a sub-agent of its own, is
-- started with that task as its parent, so the tasks of one job form a tree; and a finished task
-- keeps what the agent said was done. Every request logged from now on says how long it took.
-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN     "durationMs" INTEGER;

-- CreateIndex
CREATE INDEX "AgentTask_parentId_idx" ON "AgentTask"("parentId");
