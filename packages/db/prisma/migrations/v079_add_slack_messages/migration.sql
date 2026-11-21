-- Slack: a Slack user's link to a member of the organization, a thread's place in Slack, and the
-- messages taken from Slack, each once. None yet.

-- CreateTable
CREATE TABLE "SlackMemberLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackMemberLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackThreadPlace" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "rootTs" TEXT,
    "threadId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackThreadPlace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackMessage" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "entryId" TEXT,
    "takenUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlackMemberLink_orgId_idx" ON "SlackMemberLink"("orgId");

-- CreateIndex
CREATE INDEX "SlackMemberLink_userId_idx" ON "SlackMemberLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackMemberLink_workspaceId_slackUserId_key" ON "SlackMemberLink"("workspaceId", "slackUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackThreadPlace_threadId_key" ON "SlackThreadPlace"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackThreadPlace_appId_channel_rootTs_key" ON "SlackThreadPlace"("appId", "channel", "rootTs");

-- CreateIndex
CREATE UNIQUE INDEX "SlackMessage_entryId_key" ON "SlackMessage"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackMessage_appId_channel_ts_key" ON "SlackMessage"("appId", "channel", "ts");

