-- Chat gains Mark done and archive (`markThreads`). A member's Chat is made with their membership,
-- granting the built-in agent every one of Chat's actions (api orgs/starter-connections.ts); one
-- made before gets it here, for the built-in agent alone, as an own setting of it, where that agent
-- still reads the connection's threads, which the action needs: one whose member turned Read
-- threads off is left as it is. Nothing else changes, and running it again adds nothing. An action
-- Chat gains later is granted the same way, by a migration of its own with its id in `added`.
WITH added ("actionId") AS (
  VALUES ('markThreads')
)
INSERT INTO "AgentGrant" ("id", "agentId", "connectionId", "actionId", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, g."agentId", g."connectionId", added."actionId", true, now(), now()
FROM "AgentGrant" AS g
JOIN "Connection" AS c ON c."id" = g."connectionId" AND c."integrationId" = 'chat'
JOIN "Agent" AS a ON a."id" = g."agentId" AND a."providerId" = 'proxy' AND a."ownerUserId" IS NULL
CROSS JOIN added
WHERE g."actionId" = 'readThreads' AND g."allowed"
ON CONFLICT ("agentId", "connectionId", "actionId") DO NOTHING;
