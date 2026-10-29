-- Whether we have handled an agent's feedback: when we marked it, and a short note on how, such as
-- the pull request that fixed it. Both null while it is open, as all of it is so far.
-- AlterTable
ALTER TABLE "AgentFeedback" ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3);
