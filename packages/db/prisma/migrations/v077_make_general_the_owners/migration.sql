-- General is now the agent of the Chat page an organization starts with, made with it, shared with
-- every member and made by its owner, and never made again; nothing knows it any more by its
-- having no maker. Data only.

-- Every shared persona nobody made, which is General as it was made until now on a first listing
-- of Chat, is its organization's owner's making from here on: they change it, as they could, and
-- may make it theirs alone while nobody else has talked to it. One whose maker has left the
-- organization keeps them, and stays everyone's.
UPDATE "Persona" AS p SET "createdById" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = p."orgId" AND p."ownerUserId" IS NULL AND p."createdById" IS NULL;

-- Every organization with no persona at all, as one whose members never opened Chat, starts as a
-- new one does: with General, shared, made by its owner, with the first look
-- (`@proxy/utils/harness` DEFAULT_LOOK), in blue, run as the database's defaults have it. One
-- with personas of its members' own and none shared is left as it is.
INSERT INTO "Persona" ("id", "orgId", "name", "look", "color", "ownerUserId", "createdById")
SELECT
  gen_random_uuid()::text,
  o."id",
  'General',
  '{"nose":0.48,"noseOut":0.35,"eye":27,"eyeTheta":55,"eyeLat":8,"eyes":2}',
  'blue',
  NULL,
  o."ownerUserId"
FROM "Organization" AS o
WHERE NOT EXISTS (SELECT 1 FROM "Persona" AS p WHERE p."orgId" = o."id");
