-- Every organization has a vault of its own beside each member's: shared with everyone in it, so
-- the shared agents, which reach the shared connections alone, have a memory too. Made with the
-- organization from now on; here for every organization there is, by its owner, as the
-- organization's name, with both actions on by default as every vault has them.
INSERT INTO "Connection" (id, "orgId", "integrationId", account, "ownerUserId", "connectedById", "updatedAt")
SELECT gen_random_uuid()::text, o.id, 'vault', o.name, NULL, o."ownerUserId", now()
FROM "Organization" o;

INSERT INTO "ConnectionDefault" (id, "connectionId", "actionId", "updatedAt")
SELECT gen_random_uuid()::text, c.id, a."actionId", now()
FROM "Connection" c CROSS JOIN (VALUES ('readEntries'), ('writeEntries')) AS a("actionId")
WHERE c."integrationId" = 'vault' AND c."ownerUserId" IS NULL;
