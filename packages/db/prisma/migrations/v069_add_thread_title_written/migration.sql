-- Whether a small model wrote a thread's title, which it does once, as the thread's first turn
-- starts; not for one an alert opened, which is named by the alert. Every thread so far is named
-- by a line of its message, or by its alert; the one-off script (packages/api
-- scripts/title-threads.ts) titles those a message opened.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "titleWritten" BOOLEAN NOT NULL DEFAULT false;
