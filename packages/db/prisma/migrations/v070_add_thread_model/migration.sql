-- What runs a thread's turns, the harness and the model, which the member can change in the thread
-- without changing its persona. A thread opened before takes its persona's as it is now.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "chosenHarness" TEXT,
ADD COLUMN     "chosenModel" TEXT;

UPDATE "AgentThread" AS t
SET "chosenHarness" = p."harness", "chosenModel" = p."chatModel"
FROM "Persona" AS p
WHERE p."id" = t."personaId" AND t."parentThreadId" IS NOT NULL;
