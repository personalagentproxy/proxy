-- What agents tell the makers of Personal Agent Proxy, such as a tool that didn't work as they
-- expected, through the MCP server's send_feedback or the agent pages' feedback form.
CREATE TABLE "AgentFeedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "connectionId" TEXT,
    "tool" TEXT,
    "via" "AuditVia" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentFeedback_orgId_idx" ON "AgentFeedback"("orgId");

-- CreateIndex
CREATE INDEX "AgentFeedback_createdAt_idx" ON "AgentFeedback"("createdAt");
