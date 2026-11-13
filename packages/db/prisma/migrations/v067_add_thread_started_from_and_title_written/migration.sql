-- The thread whose agent started a thread (start_thread), so the Chat page can say so; and whether
-- a thread's title is one a small model wrote from the message that opened it. Every thread there
-- is now was opened by the member's message, and keeps the line of it it was titled with.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "startedFromThreadId" TEXT,
ADD COLUMN     "titleWritten" BOOLEAN NOT NULL DEFAULT false;
