-- Alerts: what the built-in agent sets in a member's conversation, to be woken outside it. A timed
-- alert is a job of a third kind, `alert`, due at its time. A watch is a rule on a collection of
-- some connections, each polled for what is new while any watch is on it, one poll row per
-- connection and collection.

-- AlterEnum
ALTER TYPE "AgentJobKind" ADD VALUE IF NOT EXISTS 'alert';

-- AlterTable
ALTER TABLE "AgentJob" ADD COLUMN     "alertId" TEXT;

-- CreateTable
CREATE TABLE "AgentAlert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "at" TIMESTAMP(3),
    "collectionId" TEXT,
    "connectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionPoll" (
    "connectionId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "cursor" TEXT,
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionPoll_pkey" PRIMARY KEY ("connectionId","collectionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentAlert_threadId_callId_key" ON "AgentAlert"("threadId", "callId");

-- CreateIndex
CREATE INDEX "AgentAlert_orgId_userId_idx" ON "AgentAlert"("orgId", "userId");

-- CreateIndex
CREATE INDEX "ConnectionPoll_nextAt_idx" ON "ConnectionPoll"("nextAt");
