-- GitHub's Change things on GitHub (`write`) is split in three: Open pull requests and issues
-- (`contribute`), Merge pull requests (`merge`) and Change anything else on GitHub (`manage`); and
-- Push commits (`push`) in two: Push to branches (`push`, any but the default) and Push to the
-- default branch (`pushDefault`). Each connection's defaults and each agent's own settings keep
-- what they allowed: `write` becomes the three, and `push` gains Push to the default branch, each
-- on or off as it was.
WITH split ("from", "to") AS (
  VALUES ('write', 'contribute'), ('write', 'merge'), ('write', 'manage'), ('push', 'pushDefault')
)
INSERT INTO "ConnectionDefault" ("id", "connectionId", "actionId")
SELECT gen_random_uuid()::text, d."connectionId", split."to"
FROM "ConnectionDefault" AS d
JOIN "Connection" AS c ON c."id" = d."connectionId" AND c."integrationId" = 'github'
JOIN split ON split."from" = d."actionId"
ON CONFLICT ("connectionId", "actionId") DO NOTHING;

WITH split ("from", "to") AS (
  VALUES ('write', 'contribute'), ('write', 'merge'), ('write', 'manage'), ('push', 'pushDefault')
)
INSERT INTO "AgentGrant" ("id", "agentId", "connectionId", "actionId", "allowed")
SELECT gen_random_uuid()::text, g."agentId", g."connectionId", split."to", g."allowed"
FROM "AgentGrant" AS g
JOIN "Connection" AS c ON c."id" = g."connectionId" AND c."integrationId" = 'github'
JOIN split ON split."from" = g."actionId"
ON CONFLICT ("agentId", "connectionId", "actionId") DO NOTHING;

DELETE FROM "ConnectionDefault" AS d
USING "Connection" AS c
WHERE d."connectionId" = c."id" AND c."integrationId" = 'github' AND d."actionId" = 'write';

DELETE FROM "AgentGrant" AS g
USING "Connection" AS c
WHERE g."connectionId" = c."id" AND c."integrationId" = 'github' AND g."actionId" = 'write';
