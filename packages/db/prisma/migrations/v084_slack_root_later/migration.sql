-- Slack: a thread another of the member's threads opens in Slack has its place there before the
-- app has posted its root message, which the delivery sweep posts once, noting when it first tried.

-- AlterTable
ALTER TABLE "SlackThreadPlace" ADD COLUMN     "rootTriedAt" TIMESTAMP(3);
