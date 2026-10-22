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

-- One without a member has no one to belong to.
DELETE FROM "Organization" WHERE "ownerUserId" IS NULL;

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
