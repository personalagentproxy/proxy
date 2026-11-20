-- Files are no longer optional: every server keeps their bytes (FILES_DIR or FILES_S3_BUCKET), and
-- every member has their own drive from the start, as they have a vault and a Chat. A drive was
-- made the first time it could be used; those never made are made here, called by the
-- organization's name, with everything an agent may do allowed by default.

WITH made AS (
  INSERT INTO "Connection" ("id", "orgId", "integrationId", "account", "ownerUserId", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, m."orgId", 'files', o."name", m."userId", now(), now()
  FROM "OrgMember" AS m JOIN "Organization" AS o ON o."id" = m."orgId"
  WHERE NOT EXISTS (
    SELECT 1 FROM "Connection" AS c
    WHERE c."orgId" = m."orgId" AND c."integrationId" = 'files' AND c."ownerUserId" = m."userId" AND c."name" IS NULL
  )
  RETURNING "id"
)
INSERT INTO "ConnectionDefault" ("id", "connectionId", "actionId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, made."id", d."actionId", now(), now()
FROM made
CROSS JOIN (VALUES ('readFiles'), ('createFiles'), ('editFiles'), ('trashFiles')) AS d("actionId");
