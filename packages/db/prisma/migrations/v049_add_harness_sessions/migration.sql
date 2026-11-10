-- Which harness runs each thread and what it kept from the thread's last turn; a wake job, the
-- wake-up of a thread's agent after a sleep its harness answered itself; and the Claude Agent
-- SDK's session transcripts, mirrored so any api instance can resume a thread's session.

-- AlterEnum
ALTER TYPE "AgentJobKind" ADD VALUE 'wake';

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "harness" TEXT,
ADD COLUMN     "harnessSession" TEXT;

-- CreateTable
CREATE TABLE "AgentHarnessTranscript" (
    "id" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "subpath" TEXT NOT NULL DEFAULT '',
    "seq" SERIAL NOT NULL,
    "entryUuid" TEXT,
    "entry" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentHarnessTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessTranscript_seq_key" ON "AgentHarnessTranscript"("seq");

-- CreateIndex
CREATE INDEX "AgentHarnessTranscript_projectKey_sessionId_subpath_seq_idx" ON "AgentHarnessTranscript"("projectKey", "sessionId", "subpath", "seq");

