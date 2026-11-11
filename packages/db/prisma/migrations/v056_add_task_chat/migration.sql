-- A sub-agent's chat: the member reads what a sub-agent and the agent that started it said to each
-- other, and writes to the sub-agent there. What they write lands in its thread as a person entry
-- marked `direct`, and in their conversation as a `note`, which the agent reads but is not woken by.

-- AlterEnum
ALTER TYPE "AgentEntryKind" ADD VALUE IF NOT EXISTS 'note';

-- AlterTable
ALTER TABLE "AgentEntry" ADD COLUMN "direct" BOOLEAN NOT NULL DEFAULT false;
