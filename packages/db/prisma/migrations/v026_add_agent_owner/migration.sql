-- An agent is one member's own, which nobody else in the organization sees, or shared with every
-- member of it (no owner); `createdById` is who made it, kept once it is shared. The activity log
-- and tasks say whose they are the same way, so a member's own agent's doings stay theirs.
ALTER TABLE "Agent" ADD COLUMN "createdById" TEXT,
ADD COLUMN "ownerUserId" TEXT;

-- Every organization has had one member, its owner, who made every agent in it: every agent
-- becomes their own, as every connection did, so each reaches what it reached before.
UPDATE "Agent" AS a
SET "ownerUserId" = o."ownerUserId", "createdById" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = a."orgId";

DROP INDEX "Agent_orgId_providerId_name_key";

CREATE UNIQUE INDEX "Agent_orgId_ownerUserId_providerId_name_key" ON "Agent"("orgId", "ownerUserId", "providerId", "name");

CREATE INDEX "Agent_ownerUserId_idx" ON "Agent"("ownerUserId");

ALTER TABLE "AuditEntry" ADD COLUMN "ownerUserId" TEXT;

UPDATE "AuditEntry" AS e
SET "ownerUserId" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = e."orgId";

ALTER TABLE "AgentTask" ADD COLUMN "ownerUserId" TEXT;

UPDATE "AgentTask" AS t
SET "ownerUserId" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = t."orgId";
