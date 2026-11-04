-- Alerts: what the built-in agent sets for itself in a member's conversation, to be woken outside
-- it. A timed alert is a job of a third kind, `alert`, due at its time, which lands what the agent
-- noted in the conversation. A watch is a rule on a collection of some connections: each such
-- collection is polled for what is new or changed while any watch is on it, one poll row per
-- connection and collection, claimed with a lease as a job is; a record that matches a watch's
-- criteria is kept with it, once, and lands in the conversation.

-- CreateEnum
CREATE TYPE "AgentAlertEnd" AS ENUM ('fired', 'agent', 'connection_gone', 'failed');

-- AlterEnum
ALTER TYPE "AgentJobKind" ADD VALUE IF NOT EXISTS 'alert';

-- AlterTable
ALTER TABLE "AgentJob" ADD COLUMN     "alertId" TEXT;

-- CreateTable
CREATE TABLE "AgentAlert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "at" TIMESTAMP(3),
    "collectionId" TEXT,
    "connectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "criteria" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedBy" "AgentAlertEnd",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertMatch" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionPoll" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "cursor" TEXT,
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAlert_orgId_userId_createdAt_idx" ON "AgentAlert"("orgId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAlert_threadId_idx" ON "AgentAlert"("threadId");

-- CreateIndex
CREATE INDEX "AlertMatch_alertId_createdAt_idx" ON "AlertMatch"("alertId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertMatch_alertId_recordId_key" ON "AlertMatch"("alertId", "recordId");

-- CreateIndex
CREATE INDEX "ConnectionPoll_nextAt_idx" ON "ConnectionPoll"("nextAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionPoll_connectionId_collectionId_key" ON "ConnectionPoll"("connectionId", "collectionId");
