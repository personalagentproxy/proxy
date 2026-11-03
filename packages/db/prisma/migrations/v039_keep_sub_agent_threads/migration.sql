-- A sub-agent's thread no longer ends with its report: it stops, keeping its log, and a message
-- from the agent that started it takes it up again. So nothing marks it finished.

-- AlterTable
ALTER TABLE "AgentThread" DROP COLUMN "finishedAt";
