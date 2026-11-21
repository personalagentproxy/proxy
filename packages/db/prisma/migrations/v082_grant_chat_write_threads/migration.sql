-- Chat gains Write in threads (`writeThreads`). A member's Chat is made with their membership,
-- granting the built-in agent every one of Chat's actions (api orgs/starter-connections.ts); one
-- made before gets it here, as v081_grant_chat_mark_threads granted Mark done and archive: for the
-- built-in agent alone, as an own setting of it, where that agent still reads the connection's
-- threads, which the action needs. One whose member turned Read threads off is left as it is.
-- Nothing else changes, and running it again adds nothing.
WITH added ("actionId") AS (
  VALUES ('writeThreads')
)
INSERT INTO "AgentGrant" ("id", "agentId", "connectionId", "actionId", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, g."agentId", g."connectionId", added."actionId", true, now(), now()
FROM "AgentGrant" AS g
JOIN "Connection" AS c ON c."id" = g."connectionId" AND c."integrationId" = 'chat'
JOIN "Agent" AS a ON a."id" = g."agentId" AND a."providerId" = 'proxy' AND a."ownerUserId" IS NULL
CROSS JOIN added
WHERE g."actionId" = 'readThreads' AND g."allowed"
ON CONFLICT ("agentId", "connectionId", "actionId") DO NOTHING;
