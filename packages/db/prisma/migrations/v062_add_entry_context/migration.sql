-- Where things stood as the model was told after the log, kept apart from an assistant entry's
-- system prompt, which had it at its end until now.

-- AlterTable
ALTER TABLE "AgentEntry" ADD COLUMN     "context" TEXT;
