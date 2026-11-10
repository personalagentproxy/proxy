-- A persona now says which harness runs its turns, beside the model it answers with, which is one
-- of that harness's: every persona so far ran on the proxy harness. The choice of a model is no
-- longer an insider organization's alone, so a model kept for a persona of any other, chosen while
-- it was an insider and ignored since, goes back to Claude rather than taking effect unasked. An
-- answer keeps the harness and the model that wrote it.

-- AlterTable
ALTER TABLE "Persona" ADD COLUMN     "harness" TEXT NOT NULL DEFAULT 'proxy';

UPDATE "Persona" SET "chatModel" = 'claude'
WHERE "chatModel" <> 'claude' AND "orgId" IN (SELECT "id" FROM "Organization" WHERE "insider" = false);

-- AlterTable
ALTER TABLE "AgentEntry" ADD COLUMN     "harness" TEXT,
ADD COLUMN     "model" TEXT;
