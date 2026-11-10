-- A member's own Claude credential, which the built-in agent runs under for them: a sign-in to
-- their Claude subscription, a setup token or an API key, stored encrypted; a sign-in's tokens
-- refreshed by the api itself.

-- CreateEnum
CREATE TYPE "ClaudeAccountKind" AS ENUM ('oauth', 'setup_token', 'api_key');

-- CreateTable
CREATE TABLE "ClaudeAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ClaudeAccountKind" NOT NULL,
    "credential" TEXT NOT NULL,
    "email" TEXT,
    "subscriptionType" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaudeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaudeAccount_userId_key" ON "ClaudeAccount"("userId");

