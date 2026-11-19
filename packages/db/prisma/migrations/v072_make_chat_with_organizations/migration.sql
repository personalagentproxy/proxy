-- Chat is no longer optional: every organization has its built-in agent, the login every persona
-- of the Chat page acts through, from the start, and every member their own Chat connection, as
-- they have a vault. Both were made the first time Chat was used; those that never were are made
-- here. The login's password is one nobody knows: the hash of random bytes thrown away, as the
-- api's unknownPasswordHash makes one.

INSERT INTO "Agent" ("id", "orgId", "providerId", "name", "username", "passwordHash", "ownerUserId", "createdById", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'proxy', 'Chat', 'proxy-' || substr(md5(random()::text || o."id"), 1, 12),
  '$argon2id$v=19$m=65536,t=2,p=1$xx4JPqMtNVp5kCkwbSjM7dRnOYwMMhxT4bQV/5z11K0$ImZqwq+uxvt39ZMkMOgZffJT+DHAlFMXkwxfrsrxHQ0',
  NULL, NULL, now(), now()
FROM "Organization" AS o
WHERE NOT EXISTS (SELECT 1 FROM "Agent" AS a WHERE a."orgId" = o."id" AND a."providerId" = 'proxy' AND a."ownerUserId" IS NULL);

-- Each member's Chat connection, called by the organization's name, with nothing any agent may do
-- by default and everything allowed to the built-in agent in its own settings.
WITH made AS (
  INSERT INTO "Connection" ("id", "orgId", "integrationId", "account", "ownerUserId", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, m."orgId", 'chat', o."name", m."userId", now(), now()
  FROM "OrgMember" AS m JOIN "Organization" AS o ON o."id" = m."orgId"
  WHERE NOT EXISTS (
    SELECT 1 FROM "Connection" AS c
    WHERE c."orgId" = m."orgId" AND c."integrationId" = 'chat' AND c."ownerUserId" = m."userId" AND c."name" IS NULL
  )
  RETURNING "id", "orgId"
)
INSERT INTO "AgentGrant" ("id", "agentId", "connectionId", "actionId", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."id", made."id", g."actionId", true, now(), now()
FROM made
JOIN LATERAL (
  SELECT "id" FROM "Agent"
  WHERE "orgId" = made."orgId" AND "providerId" = 'proxy' AND "ownerUserId" IS NULL
  ORDER BY "createdAt" ASC LIMIT 1
) AS a ON true
CROSS JOIN (VALUES ('readThreads'), ('readAlerts'), ('cancelAlerts')) AS g("actionId");
