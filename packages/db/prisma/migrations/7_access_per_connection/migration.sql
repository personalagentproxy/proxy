-- Access moves from the actions of each collection to the actions of the connection. A mailbox's
-- inbox, drafts and sent mail become one list, so Read on the inbox becomes Read on the mailbox;
-- Read on drafts or sent alone is dropped rather than widened to the inbox. Information's actions
-- are named for their collection: `read` on cards becomes `readCards`.

DROP INDEX "ConnectionDefault_connectionId_collectionId_actionId_key";
DELETE FROM "ConnectionDefault" WHERE "collectionId" IN ('drafts', 'sent') AND "actionId" = 'read';
UPDATE "ConnectionDefault" SET "actionId" = "actionId" || initcap("collectionId") WHERE "collectionId" IN ('addresses', 'cards', 'notes');
ALTER TABLE "ConnectionDefault" DROP COLUMN "collectionId";
CREATE UNIQUE INDEX "ConnectionDefault_connectionId_actionId_key" ON "ConnectionDefault"("connectionId", "actionId");

DROP INDEX "AgentGrant_agentId_connectionId_collectionId_actionId_key";
DELETE FROM "AgentGrant" WHERE "collectionId" IN ('drafts', 'sent') AND "actionId" = 'read';
UPDATE "AgentGrant" SET "actionId" = "actionId" || initcap("collectionId") WHERE "collectionId" IN ('addresses', 'cards', 'notes');
ALTER TABLE "AgentGrant" DROP COLUMN "collectionId";
CREATE UNIQUE INDEX "AgentGrant_agentId_connectionId_actionId_key" ON "AgentGrant"("agentId", "connectionId", "actionId");

-- The log's drafts and sent mail are now in the one email list.
UPDATE "AuditEntry" SET "collectionId" = 'emails' WHERE "collectionId" IN ('drafts', 'sent');
