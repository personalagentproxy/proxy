-- Slack: an alert set in a Slack thread that opens new threads opens them in Slack, in the
-- member's DM with the persona's app, kept on the alert.

-- AlterTable
ALTER TABLE "AgentAlert" ADD COLUMN     "slackAppId" TEXT,
ADD COLUMN     "slackChannel" TEXT;

-- CreateIndex
CREATE INDEX "AgentAlert_slackAppId_idx" ON "AgentAlert"("slackAppId");
