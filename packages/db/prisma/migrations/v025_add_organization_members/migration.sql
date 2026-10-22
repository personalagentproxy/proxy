-- Organizations with members: each has one owner, whoever made it, kept on the organization so
-- there can't be two or none; one membership per person per organization; and people are invited
-- by email, the invitation keeping only its token's hash.

ALTER TABLE "Organization" ADD COLUMN "ownerUserId" TEXT;

-- Every organization has been made with one member, who made it: its owner. The first in it, in
-- case there are more.
UPDATE "Organization" AS o
SET "ownerUserId" = (
    SELECT m."userId"
    FROM "OrgMember" AS m
    WHERE m."orgId" = o."id"
    ORDER BY m."createdAt", m."id"
    LIMIT 1
);

-- One without a member has no one to belong to: it goes, and everything in it with it, its
-- connections' credentials included. Nothing in the database takes those along (the schema's
-- relations are Prisma's, `relationMode = "prisma"`), so each is deleted here, the organization
-- last.
CREATE TEMP TABLE "GoneOrg" AS
SELECT "id" FROM "Organization" WHERE "ownerUserId" IS NULL;

CREATE TEMP TABLE "GoneAgent" AS
SELECT "id" FROM "Agent" WHERE "orgId" IN (SELECT "id" FROM "GoneOrg");

CREATE TEMP TABLE "GoneConnection" AS
SELECT "id" FROM "Connection" WHERE "orgId" IN (SELECT "id" FROM "GoneOrg");

DELETE FROM "AgentGrant"
WHERE "agentId" IN (SELECT "id" FROM "GoneAgent")
   OR "connectionId" IN (SELECT "id" FROM "GoneConnection");
DELETE FROM "AgentSession" WHERE "agentId" IN (SELECT "id" FROM "GoneAgent");
DELETE FROM "OAuthCode" WHERE "agentId" IN (SELECT "id" FROM "GoneAgent");
DELETE FROM "OAuthGrant" WHERE "agentId" IN (SELECT "id" FROM "GoneAgent");
DELETE FROM "WriteTarget" WHERE "connectionId" IN (SELECT "id" FROM "GoneConnection");
DELETE FROM "ConnectionDefault" WHERE "connectionId" IN (SELECT "id" FROM "GoneConnection");
DELETE FROM "VaultEntry" WHERE "connectionId" IN (SELECT "id" FROM "GoneConnection");
DELETE FROM "AuditEntry" WHERE "orgId" IN (SELECT "id" FROM "GoneOrg");
DELETE FROM "AgentTask" WHERE "orgId" IN (SELECT "id" FROM "GoneOrg");
DELETE FROM "AgentFeedback" WHERE "orgId" IN (SELECT "id" FROM "GoneOrg");
DELETE FROM "Agent" WHERE "id" IN (SELECT "id" FROM "GoneAgent");
DELETE FROM "Connection" WHERE "id" IN (SELECT "id" FROM "GoneConnection");
DELETE FROM "Organization" WHERE "id" IN (SELECT "id" FROM "GoneOrg");

DROP TABLE "GoneOrg", "GoneAgent", "GoneConnection";

ALTER TABLE "Organization" ALTER COLUMN "ownerUserId" SET NOT NULL;

CREATE INDEX "Organization_ownerUserId_idx" ON "Organization"("ownerUserId");

-- One membership per person per organization, the first one kept.
DELETE FROM "OrgMember" AS later
USING "OrgMember" AS earlier
WHERE later."orgId" = earlier."orgId"
  AND later."userId" = earlier."userId"
  AND (later."createdAt", later."id") > (earlier."createdAt", earlier."id");

CREATE UNIQUE INDEX "OrgMember_orgId_userId_key" ON "OrgMember"("orgId", "userId");

CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

CREATE INDEX "Invitation_orgId_idx" ON "Invitation"("orgId");
