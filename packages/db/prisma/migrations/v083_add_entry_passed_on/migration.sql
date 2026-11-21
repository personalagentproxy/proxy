-- Chat: a message one of the member's threads passes on to another, at their asking, lands there
-- as theirs, and says which thread it was passed on from.

-- AlterTable
ALTER TABLE "AgentEntry" ADD COLUMN     "passedOnFromId" TEXT;
