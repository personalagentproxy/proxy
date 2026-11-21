-- Slack: a workspace linked to an organization, and a shared persona's own Slack app in one.
-- None is linked yet.

-- CreateTable
CREATE TABLE "SlackWorkspace" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "linkedById" TEXT,
    "credential" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotateAt" TIMESTAMP(3) NOT NULL,
    "refusedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackApp" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackAppId" TEXT,
    "clientId" TEXT,
    "secrets" TEXT,
    "manifestVersion" INTEGER NOT NULL,
    "manifestName" TEXT NOT NULL,
    "botToken" TEXT,
    "botUserId" TEXT,
    "botName" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "installedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackApp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlackWorkspace_rotateAt_idx" ON "SlackWorkspace"("rotateAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlackWorkspace_orgId_teamId_key" ON "SlackWorkspace"("orgId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackApp_personaId_key" ON "SlackApp"("personaId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackApp_slackAppId_key" ON "SlackApp"("slackAppId");

-- CreateIndex
CREATE INDEX "SlackApp_orgId_idx" ON "SlackApp"("orgId");

-- CreateIndex
CREATE INDEX "SlackApp_workspaceId_idx" ON "SlackApp"("workspaceId");

