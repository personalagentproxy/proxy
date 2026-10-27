-- An entry that lands in a thread while the model is answering on its log, the person speaking or
-- a sub-agent reporting, is pending: not in the log the model reads yet, and given its place after
-- the answer once that is written.

-- AlterTable
ALTER TABLE "AgentEntry" ADD COLUMN     "pending" BOOLEAN NOT NULL DEFAULT false;
