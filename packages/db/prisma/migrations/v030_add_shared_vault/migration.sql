-- Every organization has a vault of its own beside each member's: shared with everyone in it, so
-- the shared agents, which reach the shared connections alone, have a memory too. Made with the
-- organization from now on; here for every organization there is, by its owner, as the
-- organization's name, with both actions on by default as every vault has them. The defaults go
-- on the vaults made here alone: a vault without an organization, left by one deleted from under
-- it, has its own already.
WITH vault AS (
  INSERT INTO "Connection" (id, "orgId", "integrationId", account, "ownerUserId", "connectedById", "updatedAt")
  SELECT gen_random_uuid()::text, o.id, 'vault', o.name, NULL, o."ownerUserId", now()
  FROM "Organization" o
  RETURNING id
)
INSERT INTO "ConnectionDefault" (id, "connectionId", "actionId", "updatedAt")
SELECT gen_random_uuid()::text, vault.id, a."actionId", now()
FROM vault CROSS JOIN (VALUES ('readEntries'), ('writeEntries')) AS a("actionId");
