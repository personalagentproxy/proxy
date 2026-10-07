-- No column default: an agent's provider is chosen when its login is made, and there are no
-- agents yet to fill in.
ALTER TABLE "Agent" ADD COLUMN "providerId" TEXT NOT NULL;

CREATE UNIQUE INDEX "Agent_orgId_providerId_key" ON "Agent"("orgId", "providerId");
