-- Alerts come either to the thread they were set in or to the chat, where each opens a new thread
-- as it comes; a timed one that opens new threads may repeat, read in the member's time zone, which
-- the member now has. Every alert there is comes to its thread, as alerts did: its chat is its
-- thread's, and it was set in it.

-- CreateEnum
CREATE TYPE "AlertSplit" AS ENUM ('per_check', 'per_record');

-- AlterTable
ALTER TABLE "AgentAlert" ADD COLUMN     "chatId" TEXT,
ADD COLUMN     "every" TEXT,
ADD COLUMN     "setInThreadId" TEXT,
ADD COLUMN     "split" "AlertSplit",
ADD COLUMN     "timeZone" TEXT,
ALTER COLUMN "threadId" DROP NOT NULL;

UPDATE "AgentAlert" AS a
SET "chatId" = COALESCE(t."parentThreadId", t."id"), "setInThreadId" = a."threadId"
FROM "AgentThread" AS t
WHERE t."id" = a."threadId";

-- An alert whose thread is gone has nowhere to come.
DELETE FROM "AgentAlert" WHERE "chatId" IS NULL;

ALTER TABLE "AgentAlert" ALTER COLUMN "chatId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "openedByAlert" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timeZone" TEXT;

-- CreateIndex
CREATE INDEX "AgentAlert_chatId_idx" ON "AgentAlert"("chatId");

-- CreateIndex
CREATE INDEX "AgentAlert_setInThreadId_idx" ON "AgentAlert"("setInThreadId");
