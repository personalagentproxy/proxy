-- Every member has their own Memory from the start, as they have a vault, a Chat and a drive: the
-- notes all their agents share, kept as a drive's files are. Those of members who joined before
-- are made here, called by the organization's name, agents allowed to read and write them by
-- default.

WITH made AS (
  INSERT INTO "Connection" ("id", "orgId", "integrationId", "account", "ownerUserId", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, m."orgId", 'memory', o."name", m."userId", now(), now()
  FROM "OrgMember" AS m JOIN "Organization" AS o ON o."id" = m."orgId"
  WHERE NOT EXISTS (
    SELECT 1 FROM "Connection" AS c
    WHERE c."orgId" = m."orgId" AND c."integrationId" = 'memory' AND c."ownerUserId" = m."userId" AND c."name" IS NULL
  )
  RETURNING "id"
)
INSERT INTO "ConnectionDefault" ("id", "connectionId", "actionId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, made."id", d."actionId", now(), now()
FROM made
CROSS JOIN (VALUES ('readMemory'), ('writeMemory')) AS d("actionId");
