-- A task never finished is taken as abandoned a day after it, or the last of its sub-tasks at any
-- depth, was started, no longer a day after it alone was: so a parent isn't abandoned while one of
-- its sub-tasks is under way. Each task's is the latest start in the tree below it.
-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "lastStartedAt" TIMESTAMP(3);

WITH RECURSIVE "below" AS (
	SELECT "id" AS "taskId", "id", "createdAt" FROM "AgentTask"
	UNION ALL
	SELECT "below"."taskId", "task"."id", "task"."createdAt"
	FROM "AgentTask" AS "task"
	JOIN "below" ON "task"."parentId" = "below"."id"
)
UPDATE "AgentTask"
SET "lastStartedAt" = "latest"."at"
FROM (SELECT "taskId", MAX("createdAt") AS "at" FROM "below" GROUP BY "taskId") AS "latest"
WHERE "AgentTask"."id" = "latest"."taskId";

ALTER TABLE "AgentTask" ALTER COLUMN "lastStartedAt" SET NOT NULL;
