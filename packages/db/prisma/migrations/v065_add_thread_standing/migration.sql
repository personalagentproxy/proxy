-- Where a thread stands: whether its agent waits for the member, and the sentence that says
-- where it is, with the entry it was written up to. Every thread there is now, those v063 made
-- and any opened since, is done, with no summary: a one-off script writes the summaries
-- (packages/api/scripts/summarize-threads.ts), and leaves whether a thread waits as it is.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summarySeq" INTEGER,
ADD COLUMN     "waitingForMember" BOOLEAN NOT NULL DEFAULT false;
