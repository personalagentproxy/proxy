-- The User-Agent each session signed in with, for the account page's list of sessions.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "userAgent" TEXT;
