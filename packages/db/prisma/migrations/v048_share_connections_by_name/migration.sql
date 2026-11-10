-- A connection is one member's, who shares it with every member of the organization
-- (`sharedWithEveryone`), with members by name (ConnectionShare), or both, and takes it back again.
-- Before, it was a member's own or, with no owner, every member's for good.
ALTER TABLE "Connection" ADD COLUMN "sharedWithEveryone" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ConnectionShare" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionShare_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConnectionShare_userId_idx" ON "ConnectionShare"("userId");

CREATE UNIQUE INDEX "ConnectionShare_connectionId_userId_key" ON "ConnectionShare"("connectionId", "userId");

-- Every shared connection that stays is given whose it is, below; one left with no owner after
-- that goes, with what hangs on it, which nothing in the database deletes with it.

-- Sandboxes are each member's own from now on: the organization has no shared Sandboxes
-- connection. The sandboxes on one move to its owner's own connection, so none is left running
-- with nothing to name it; where the owner has none yet, the shared connection becomes theirs,
-- with what a member's own starts with, and without the settings agents had on it while shared.
UPDATE "Sandbox" AS s
SET "connectionId" = own."id"
FROM "Connection" AS c
JOIN "Organization" AS o ON o."id" = c."orgId"
JOIN "Connection" AS own ON own."orgId" = c."orgId" AND own."integrationId" = 'sandbox' AND own."ownerUserId" = o."ownerUserId"
WHERE s."connectionId" = c."id" AND c."integrationId" = 'sandbox' AND c."ownerUserId" IS NULL;

DELETE FROM "AgentGrant" AS g
USING "Connection" AS c
WHERE g."connectionId" = c."id" AND c."integrationId" = 'sandbox' AND c."ownerUserId" IS NULL
  AND EXISTS (SELECT 1 FROM "Sandbox" AS s WHERE s."connectionId" = c."id");

INSERT INTO "ConnectionDefault" ("id", "connectionId", "actionId", "updatedAt")
SELECT gen_random_uuid()::text, c."id", a."actionId", now()
FROM "Connection" AS c CROSS JOIN (VALUES ('read'), ('run')) AS a("actionId")
WHERE c."integrationId" = 'sandbox' AND c."ownerUserId" IS NULL
  AND EXISTS (SELECT 1 FROM "Sandbox" AS s WHERE s."connectionId" = c."id")
ON CONFLICT ("connectionId", "actionId") DO NOTHING;

UPDATE "Connection" AS c
SET "ownerUserId" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = c."orgId" AND c."integrationId" = 'sandbox' AND c."ownerUserId" IS NULL
  AND EXISTS (SELECT 1 FROM "Sandbox" AS s WHERE s."connectionId" = c."id");

-- The organization has no vault of its own from now on: members make vaults, each named, and
-- share them as any connection. One with entries stays as a vault its organization's owner made,
-- named after the organization and shared with every member, as it was; one nothing was kept in
-- goes.
UPDATE "Connection" AS c
SET "name" = c."account", "sharedWithEveryone" = true, "ownerUserId" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = c."orgId" AND c."integrationId" = 'vault' AND c."ownerUserId" IS NULL
  AND EXISTS (SELECT 1 FROM "VaultEntry" AS e WHERE e."connectionId" = c."id");

-- Every other shared connection stays shared with every member, and is whoever connected it's
-- while they are still in the organization, else its owner's: the two who could change it.
UPDATE "Connection" AS c
SET "sharedWithEveryone" = true,
    "ownerUserId" = COALESCE(
      (SELECT m."userId" FROM "OrgMember" AS m WHERE m."orgId" = c."orgId" AND m."userId" = c."connectedById"),
      o."ownerUserId"
    )
FROM "Organization" AS o
WHERE o."id" = c."orgId" AND c."ownerUserId" IS NULL AND c."integrationId" NOT IN ('vault', 'sandbox');

-- What is left with no owner goes: the shared Sandboxes connections without a sandbox, and the
-- organizations' vaults without an entry, each with its defaults, every agent's settings on it,
-- and the rest that hangs on a connection.
DELETE FROM "ConnectionDefault" WHERE "connectionId" IN (SELECT "id" FROM "Connection" WHERE "ownerUserId" IS NULL);
DELETE FROM "AgentGrant" WHERE "connectionId" IN (SELECT "id" FROM "Connection" WHERE "ownerUserId" IS NULL);
DELETE FROM "WriteTarget" WHERE "connectionId" IN (SELECT "id" FROM "Connection" WHERE "ownerUserId" IS NULL);
DELETE FROM "ConnectionPoll" WHERE "connectionId" IN (SELECT "id" FROM "Connection" WHERE "ownerUserId" IS NULL);
DELETE FROM "VaultEntry" WHERE "connectionId" IN (SELECT "id" FROM "Connection" WHERE "ownerUserId" IS NULL);
DELETE FROM "Sandbox" WHERE "connectionId" IN (SELECT "id" FROM "Connection" WHERE "ownerUserId" IS NULL);
DELETE FROM "Connection" WHERE "ownerUserId" IS NULL;
