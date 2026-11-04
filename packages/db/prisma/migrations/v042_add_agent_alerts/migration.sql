-- Alerts: what the built-in agent sets in a member's conversation, to be woken outside it, at a
-- time or by a watch on a collection of some connections. A timed alert is due at `nextAt`; a
-- watch reads each connection's collection through its poll, one row per connection and
-- collection, which every watch on it shares.

-- CreateTable
CREATE TABLE "AgentAlert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "at" TIMESTAMP(3),
    "nextAt" TIMESTAMP(3),
    "collectionId" TEXT,
    "connectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastMatchedAt" TIMESTAMP(3),
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
CREATE INDEX "AgentAlert_threadId_idx" ON "AgentAlert"("threadId");

-- CreateIndex
CREATE INDEX "AgentAlert_orgId_userId_idx" ON "AgentAlert"("orgId", "userId");

-- CreateIndex
CREATE INDEX "AgentAlert_nextAt_idx" ON "AgentAlert"("nextAt");

-- CreateIndex
CREATE INDEX "ConnectionPoll_nextAt_idx" ON "ConnectionPoll"("nextAt");

