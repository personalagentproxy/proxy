-- A sub-agent's thread no longer ends with its report: it stops, keeping its log, and a message
-- from the agent that started it takes it up again. So nothing marks it finished.

-- AlterTable
ALTER TABLE "AgentThread" DROP COLUMN "finishedAt";

-- The chat agent's delegate call is gone, create_subagent in its place, which starts the sub-agent
-- as the call is answered rather than in a job of its own. A delegate call's job still open would
-- be answered a second time, "There is no tool delegate.", so each is failed, saying why.
UPDATE "AgentJob" AS "job"
SET "status" = 'failed',
	"error" = 'delegate was replaced by create_subagent before this job ran',
	"claimedBy" = NULL,
	"leaseExpiresAt" = NULL,
	"updatedAt" = now() AT TIME ZONE 'UTC'
FROM "AgentEntry" AS "entry"
WHERE "job"."entryId" = "entry"."id"
	AND "job"."kind" = 'tool'
	AND "job"."status" IN ('queued', 'running')
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements("entry"."toolCalls"::jsonb) AS "call"
		WHERE "call"->>'id' = "job"."callId" AND "call"->>'name' = 'delegate'
	);
