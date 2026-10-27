-- A task never finished is taken as left open 20 minutes after anything was last done for it or
-- for one of its sub-tasks at any depth, no longer a day after the last of them was started. Each
-- task's is the latest start, or request made, in the tree below it.
-- AlterTable
ALTER TABLE "AgentTask" RENAME COLUMN "lastStartedAt" TO "lastActiveAt";

WITH RECURSIVE "below" AS (
	SELECT "id" AS "taskId", "id" FROM "AgentTask"
	UNION ALL
	SELECT "below"."taskId", "task"."id"
	FROM "AgentTask" AS "task"
	JOIN "below" ON "task"."parentId" = "below"."id"
)
UPDATE "AgentTask"
SET "lastActiveAt" = "latest"."at"
FROM (
	SELECT "below"."taskId", MAX("entry"."createdAt") AS "at"
	FROM "below"
	JOIN "AuditEntry" AS "entry" ON "entry"."taskId" = "below"."id"
	GROUP BY "below"."taskId"
) AS "latest"
WHERE "AgentTask"."id" = "latest"."taskId" AND "latest"."at" > "AgentTask"."lastActiveAt";
