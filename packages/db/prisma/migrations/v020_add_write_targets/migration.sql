-- What Personal Agent Proxy does itself for a person, as the home page's widgets write, is logged
-- beside the agents' requests, without an agent.
ALTER TABLE "AuditEntry" ALTER COLUMN "agentId" DROP NOT NULL;

-- Where the home page's widgets write when there is more than one place: the last calendar or
-- mailbox each person wrote to, per collection.
CREATE TABLE "WriteTarget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "parent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WriteTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WriteTarget_connectionId_idx" ON "WriteTarget"("connectionId");

CREATE UNIQUE INDEX "WriteTarget_userId_collectionId_key" ON "WriteTarget"("userId", "collectionId");
