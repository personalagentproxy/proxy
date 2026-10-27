-- The Chat page: the organization's personas, agents Personal Agent Proxy runs itself, each named
-- and given a head, all acting through the organization's one built-in agent login; a thread per
-- member and persona, the member's conversation with it, and a thread per sub-agent started from
-- it, each with its log of entries (what the person said, what the model answered with its tool
-- calls, what each call answered, events that came since, and summaries of the log once it has
-- grown long), and the jobs that run them (the model on a log, one tool call), claimed by one api
-- instance at a time with a lease. A sub-agent's task says which persona it ran as. Their requests
-- come in a third way, `harness`, beside the agent pages and the MCP server.

-- CreateEnum
CREATE TYPE "AgentEntryKind" AS ENUM ('person', 'assistant', 'tool_result', 'event', 'summary');

-- CreateEnum
CREATE TYPE "AgentJobKind" AS ENUM ('inference', 'tool');

-- CreateEnum
CREATE TYPE "AgentJobStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- AlterEnum
ALTER TYPE "AuditVia" ADD VALUE IF NOT EXISTS 'harness';

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "personaId" TEXT;

-- CreateTable
CREATE TABLE "Persona" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "look" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentThread" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentThreadId" TEXT,
    "parentCallId" TEXT,
    "title" TEXT,
    "taskId" TEXT,
    "finishedAt" TIMESTAMP(3),
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
    "coversSeq" INTEGER,
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
CREATE INDEX "Persona_orgId_createdAt_idx" ON "Persona"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentThread_personaId_userId_idx" ON "AgentThread"("personaId", "userId");

-- CreateIndex
CREATE INDEX "AgentThread_agentId_idx" ON "AgentThread"("agentId");

-- CreateIndex
CREATE INDEX "AgentThread_parentThreadId_idx" ON "AgentThread"("parentThreadId");

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

