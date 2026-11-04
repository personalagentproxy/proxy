-- The model the built-in agent answers with is each persona's now, not the organization's: every
-- persona starts with the one its organization had chosen.

-- AlterTable
ALTER TABLE "Persona" ADD COLUMN     "chatModel" TEXT NOT NULL DEFAULT 'claude';

UPDATE "Persona" AS "persona"
SET "chatModel" = "org"."chatModel"
FROM "Organization" AS "org"
WHERE "persona"."orgId" = "org"."id";

-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "chatModel";
