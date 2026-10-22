-- The built-in agent: a thread per conversation, shown as a persona with a name and an avatar,
-- with its log of entries (what the person said,
-- what the model answered with its tool calls, and what each call answered), and the jobs that
-- run it (the model on a log, one tool call), claimed by one api instance at a time with a lease.
-- Its requests come in a third way, `harness`, beside the agent pages and the MCP server.

-- CreateEnum
CREATE TYPE "AgentEntryKind" AS ENUM ('person', 'assistant', 'tool_result');

-- CreateEnum
CREATE TYPE "AgentJobKind" AS ENUM ('inference', 'tool');

-- CreateEnum
CREATE TYPE "AgentJobStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- AlterEnum
ALTER TYPE "AuditVia" ADD VALUE IF NOT EXISTS 'harness';

-- CreateTable
CREATE TABLE "AgentThread" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEntry" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" "AgentEntryKind" NOT NULL,
    "text" TEXT NOT NULL,
    "toolCalls" TEXT,
    "callId" TEXT,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" "AgentJobKind" NOT NULL,
    "status" "AgentJobStatus" NOT NULL DEFAULT 'queued',
    "entryId" TEXT,
    "callId" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentThread_orgId_createdAt_idx" ON "AgentThread"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEntry_seq_key" ON "AgentEntry"("seq");

-- CreateIndex
CREATE INDEX "AgentEntry_threadId_seq_idx" ON "AgentEntry"("threadId", "seq");

-- CreateIndex
CREATE INDEX "AgentJob_status_runAt_idx" ON "AgentJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "AgentJob_threadId_idx" ON "AgentJob"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentJob_entryId_callId_key" ON "AgentJob"("entryId", "callId");

