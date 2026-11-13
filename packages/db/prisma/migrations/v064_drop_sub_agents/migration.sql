-- Chat on threads, the old path gone: nothing starts a sub-agent by a call any more, nothing pins
-- one, the member writes to no sub-agent directly, and no chat keeps notes of what they wrote to
-- one. v063 reshaped every chat from before, so these hold nothing the code reads; a note left
-- behind is deleted before its kind goes. Postgres can't drop a value
-- from an enum, so the enum is made anew.

DELETE FROM "AgentEntry" WHERE "kind" = 'note';

-- AlterEnum
BEGIN;
CREATE TYPE "AgentEntryKind_new" AS ENUM ('person', 'assistant', 'tool_result', 'event', 'summary');
ALTER TABLE "AgentEntry" ALTER COLUMN "kind" TYPE "AgentEntryKind_new" USING ("kind"::text::"AgentEntryKind_new");
ALTER TYPE "AgentEntryKind" RENAME TO "AgentEntryKind_old";
ALTER TYPE "AgentEntryKind_new" RENAME TO "AgentEntryKind";
DROP TYPE "public"."AgentEntryKind_old";
COMMIT;

-- AlterTable
ALTER TABLE "AgentEntry" DROP COLUMN "direct";

-- AlterTable
ALTER TABLE "AgentThread" DROP COLUMN "parentCallId",
DROP COLUMN "pinnedAt";
