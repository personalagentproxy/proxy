-- The model an organization's built-in agent answers with, which an insider switches on Settings;
-- for any other organization it is ignored.
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "chatModel" TEXT NOT NULL DEFAULT 'claude';
