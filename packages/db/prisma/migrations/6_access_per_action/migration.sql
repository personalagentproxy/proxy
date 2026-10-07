-- Access moves from one level per collection (none, read, write) to one setting per action. Every
-- collection has `read`; Information's and drafts also have `write`. Received emails had `write`
-- capped to read, so it becomes `read` there.

-- Defaults: one row per action that is on. read keeps `read`, write gets `read` and `write`.
DROP INDEX "ConnectionDefault_connectionId_collectionId_key";
ALTER TABLE "ConnectionDefault" ADD COLUMN "actionId" TEXT;

UPDATE "ConnectionDefault" SET "actionId" = 'read' WHERE "access" IN ('read', 'write');

INSERT INTO "ConnectionDefault" ("id", "connectionId", "collectionId", "actionId", "access", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "connectionId", "collectionId", 'write', "access", "createdAt", "updatedAt"
FROM "ConnectionDefault"
WHERE "access" = 'write' AND "collectionId" <> 'emails';

DELETE FROM "ConnectionDefault" WHERE "access" = 'none';

ALTER TABLE "ConnectionDefault" DROP COLUMN "access";
ALTER TABLE "ConnectionDefault" ALTER COLUMN "actionId" SET NOT NULL;
CREATE UNIQUE INDEX "ConnectionDefault_connectionId_collectionId_actionId_key" ON "ConnectionDefault"("connectionId", "collectionId", "actionId");

-- An agent's own settings: on or off for `read`, and for `write` where the collection has it, so
-- an agent set below its default stays there.
DROP INDEX "AgentGrant_agentId_connectionId_collectionId_key";
ALTER TABLE "AgentGrant" ADD COLUMN "actionId" TEXT;
ALTER TABLE "AgentGrant" ADD COLUMN "allowed" BOOLEAN;

UPDATE "AgentGrant" SET "actionId" = 'read', "allowed" = ("access" <> 'none');

INSERT INTO "AgentGrant" ("id", "agentId", "connectionId", "collectionId", "actionId", "allowed", "access", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "agentId", "connectionId", "collectionId", 'write', ("access" = 'write'), "access", "createdAt", "updatedAt"
FROM "AgentGrant"
WHERE "collectionId" <> 'emails';

ALTER TABLE "AgentGrant" DROP COLUMN "access";
ALTER TABLE "AgentGrant" ALTER COLUMN "actionId" SET NOT NULL;
ALTER TABLE "AgentGrant" ALTER COLUMN "allowed" SET NOT NULL;
CREATE UNIQUE INDEX "AgentGrant_agentId_connectionId_collectionId_actionId_key" ON "AgentGrant"("agentId", "connectionId", "collectionId", "actionId");

DROP TYPE "Access";

-- The log names commands too, such as `send`, so the action is the catalog's id.
ALTER TABLE "AuditEntry" ALTER COLUMN "action" TYPE TEXT USING "action"::text;

DROP TYPE "AuditAction";
