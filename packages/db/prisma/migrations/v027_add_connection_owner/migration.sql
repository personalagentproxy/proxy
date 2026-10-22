-- A connection is one member's, which nobody else in the organization sees, or shared with every
-- member of it (no owner); `connectedById` is who connected it, kept once it is shared.
ALTER TABLE "Connection" ADD COLUMN "connectedById" TEXT,
ADD COLUMN "ownerUserId" TEXT;

CREATE INDEX "Connection_ownerUserId_idx" ON "Connection"("ownerUserId");

-- Every organization has had one member, its owner, who connected everything in it: every
-- connection there, the vault included, becomes their own, connected by them. Nothing becomes
-- shared by itself.
UPDATE "Connection" AS c
SET "ownerUserId" = o."ownerUserId", "connectedById" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = c."orgId";
