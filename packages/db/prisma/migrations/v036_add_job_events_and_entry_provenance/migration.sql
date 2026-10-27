-- What a debug inspector can't rebuild from a thread's log: an assistant entry's system prompt,
-- built from the login's grants as they were then; the job that wrote each entry the worker
-- wrote; and what happened to each job, one row per happening, since the job's row is the
-- queue's lock and keeps only its last attempt.

-- CreateEnum
CREATE TYPE "AgentJobEventKind" AS ENUM ('claimed', 'requeued', 'done', 'failed');

-- AlterTable
ALTER TABLE "AgentEntry" ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "system" TEXT;

-- CreateTable
CREATE TABLE "AgentJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" "AgentJobEventKind" NOT NULL,
    "workerId" TEXT,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentJobEvent_jobId_at_idx" ON "AgentJobEvent"("jobId", "at");

-- CreateIndex
CREATE INDEX "AgentJobEvent_threadId_at_idx" ON "AgentJobEvent"("threadId", "at");
