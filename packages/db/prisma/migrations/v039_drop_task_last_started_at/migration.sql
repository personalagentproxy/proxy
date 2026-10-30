-- "lastActiveAt" took over from "lastStartedAt" in v037, which kept it only for the instances
-- still on the version before while a deploy replaced them. Nothing reads it now.
-- AlterTable
ALTER TABLE "AgentTask" DROP COLUMN "lastStartedAt";
