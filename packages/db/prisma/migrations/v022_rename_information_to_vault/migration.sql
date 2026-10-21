-- Information is now the vault: one collection of entries, a key, a type and a value each, in
-- place of addresses, payment cards and notes. The api turns the records into entries as it
-- starts, since only it can read them (`records/vault-entries.ts`); here, the names and access.

ALTER TABLE "InfoRecord" RENAME TO "VaultEntry";
ALTER TABLE "VaultEntry" RENAME CONSTRAINT "InfoRecord_pkey" TO "VaultEntry_pkey";
ALTER INDEX "InfoRecord_connectionId_collectionId_idx" RENAME TO "VaultEntry_connectionId_collectionId_idx";

UPDATE "Connection" SET "integrationId" = 'vault' WHERE "integrationId" = 'info';

-- Six actions become two: Read entries where any of the reads was on, Edit entries where any of the
-- edits was. Only the vault's: Granola has a `readNotes` of its own.
CREATE TEMP TABLE "OldVaultAction" ("actionId" TEXT, "newActionId" TEXT);
INSERT INTO "OldVaultAction" VALUES
	('readAddresses', 'readEntries'), ('readCards', 'readEntries'), ('readNotes', 'readEntries'),
	('writeAddresses', 'writeEntries'), ('writeCards', 'writeEntries'), ('writeNotes', 'writeEntries');

-- An agent's own setting, where it had one for any of them: what it could do with any of them,
-- its setting where it had one and the default where it hadn't. Worked out before the defaults
-- change, kept on one of its rows.
CREATE TEMP TABLE "NewVaultGrant" AS
SELECT min(g.id) AS id, g."agentId", g."connectionId", o."newActionId",
	(SELECT bool_or(COALESCE(own.allowed, d.id IS NOT NULL))
	 FROM "OldVaultAction" o2
	 LEFT JOIN "AgentGrant" own ON own."agentId" = g."agentId" AND own."connectionId" = g."connectionId" AND own."actionId" = o2."actionId"
	 LEFT JOIN "ConnectionDefault" d ON d."connectionId" = g."connectionId" AND d."actionId" = o2."actionId"
	 WHERE o2."newActionId" = o."newActionId") AS allowed
FROM "AgentGrant" g
JOIN "OldVaultAction" o ON o."actionId" = g."actionId"
JOIN "Connection" c ON c.id = g."connectionId" AND c."integrationId" = 'vault'
GROUP BY g."agentId", g."connectionId", o."newActionId";

UPDATE "AgentGrant" g SET "actionId" = n."newActionId", allowed = n.allowed
FROM "NewVaultGrant" n WHERE g.id = n.id;

DELETE FROM "AgentGrant" g USING "OldVaultAction" o, "Connection" c
WHERE g."actionId" = o."actionId" AND c.id = g."connectionId" AND c."integrationId" = 'vault';

-- The defaults: a row is on, so one row per new action that any old one was on for.
UPDATE "ConnectionDefault" d SET "actionId" = o."newActionId"
FROM "OldVaultAction" o
WHERE d."actionId" = o."actionId" AND d.id IN (
	SELECT min(d2.id) FROM "ConnectionDefault" d2
	JOIN "OldVaultAction" o2 ON o2."actionId" = d2."actionId"
	JOIN "Connection" c ON c.id = d2."connectionId" AND c."integrationId" = 'vault'
	GROUP BY d2."connectionId", o2."newActionId"
);

DELETE FROM "ConnectionDefault" d USING "OldVaultAction" o, "Connection" c
WHERE d."actionId" = o."actionId" AND c.id = d."connectionId" AND c."integrationId" = 'vault';

DROP TABLE "NewVaultGrant";
DROP TABLE "OldVaultAction";

-- The activity log names the one collection now.
UPDATE "AuditEntry" a SET "collectionId" = 'entries'
FROM "Connection" c
WHERE c.id = a."connectionId" AND c."integrationId" = 'vault' AND a."collectionId" IN ('addresses', 'cards', 'notes');
