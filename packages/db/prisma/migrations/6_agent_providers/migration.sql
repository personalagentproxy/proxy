-- Existing free-form agents remain usable with a null providerId. New agents always have one,
-- and PostgreSQL permits multiple nulls while enforcing one login per provider and organization.
ALTER TABLE "Agent" ADD COLUMN "providerId" TEXT;

CREATE UNIQUE INDEX "Agent_orgId_providerId_key" ON "Agent"("orgId", "providerId");
