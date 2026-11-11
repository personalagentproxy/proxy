-- A persona is now whoever made it's, who alone sees it; until now every member of its
-- organization saw every persona. One whose maker is still a member, and which nobody else has a
-- conversation with, becomes its maker's. Every other stays every member's: General, which nobody
-- made, one whose maker has left, and one another member has talked to, who keeps the
-- conversation.

-- AlterTable
ALTER TABLE "Persona" ADD COLUMN     "ownerUserId" TEXT;

UPDATE "Persona" AS p SET "ownerUserId" = p."createdById"
WHERE p."createdById" IS NOT NULL
	AND EXISTS (SELECT 1 FROM "OrgMember" AS m WHERE m."orgId" = p."orgId" AND m."userId" = p."createdById")
	AND NOT EXISTS (SELECT 1 FROM "AgentThread" AS t WHERE t."personaId" = p."id" AND t."userId" <> p."createdById");

-- CreateIndex
CREATE INDEX "Persona_ownerUserId_idx" ON "Persona"("ownerUserId");
