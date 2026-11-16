ALTER TABLE "AgentThread" ADD COLUMN "delegated" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "AgentDelegation" (
 "id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL, "rootThreadId" TEXT NOT NULL,
 "sourceThreadId" TEXT NOT NULL REFERENCES "AgentThread"("id") ON DELETE CASCADE,
 "childThreadId" TEXT NOT NULL UNIQUE REFERENCES "AgentThread"("id") ON DELETE CASCADE,
 "callKey" TEXT NOT NULL, "targetPersonaId" TEXT NOT NULL, "targetName" TEXT NOT NULL,
 "initiatorUserId" TEXT, "teamAudience" BOOLEAN NOT NULL, "ancestors" TEXT[] NOT NULL,
 "task" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'running', "result" TEXT,
 "deliveredAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AgentDelegation_status_check" CHECK ("status" IN ('running', 'completed', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX "AgentDelegation_sourceThreadId_callKey_key" ON "AgentDelegation"("sourceThreadId", "callKey");
CREATE INDEX "AgentDelegation_rootThreadId_idx" ON "AgentDelegation"("rootThreadId");
CREATE INDEX "AgentDelegation_status_deliveredAt_idx" ON "AgentDelegation"("status", "deliveredAt");
