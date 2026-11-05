-- CreateEnum
CREATE TYPE "SandboxState" AS ENUM ('running', 'asleep');

-- CreateTable
CREATE TABLE "Sandbox" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" "SandboxState" NOT NULL,
    "backendId" TEXT NOT NULL,
    "backendRef" TEXT NOT NULL,
    "heldByTaskId" TEXT,
    "heldAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sandbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sandbox_connectionId_createdAt_idx" ON "Sandbox"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "Sandbox_orgId_idx" ON "Sandbox"("orgId");

-- CreateIndex
CREATE INDEX "Sandbox_state_lastUsedAt_idx" ON "Sandbox"("state", "lastUsedAt");

