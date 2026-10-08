-- When the organization finished or skipped the welcome flow. Organizations from before it
-- count as done, so nobody who already set things up is sent through it.
ALTER TABLE "Organization" ADD COLUMN "onboardedAt" TIMESTAMP(3);

UPDATE "Organization" SET "onboardedAt" = CURRENT_TIMESTAMP;
