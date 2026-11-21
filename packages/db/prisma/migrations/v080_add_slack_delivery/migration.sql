-- Slack: how far each thread's place in Slack is delivered there, and the sweep's hold on it; where
-- the thread stands there, as its agent session's status and title; and the apps whose workspace
-- has no agent sessions for now.

-- CreateEnum
CREATE TYPE "SlackSessionStatus" AS ENUM ('processing', 'suspended', 'active');

-- AlterTable
ALTER TABLE "SlackApp" ADD COLUMN     "sessionsOffUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SlackThreadPlace" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "deliveredSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "partSeq" INTEGER,
ADD COLUMN     "partsPosted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sessionAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sessionRetryAt" TIMESTAMP(3),
ADD COLUMN     "sessionSetAt" TIMESTAMP(3),
ADD COLUMN     "sessionStatus" "SlackSessionStatus",
ADD COLUMN     "sessionTitle" TEXT,
ADD COLUMN     "stoppedAt" TIMESTAMP(3),
ADD COLUMN     "stoppedWhy" TEXT;

-- A place made before answers went back to Slack is delivered from now on: what its thread said
-- before isn't posted all at once now.
UPDATE "SlackThreadPlace" AS p SET "deliveredSeq" = COALESCE((SELECT MAX(e."seq") FROM "AgentEntry" AS e WHERE e."threadId" = p."threadId"), 0);

-- CreateIndex
CREATE INDEX "SlackThreadPlace_stoppedAt_nextAt_idx" ON "SlackThreadPlace"("stoppedAt", "nextAt");
