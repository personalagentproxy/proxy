-- Custom MCP agents: any number per organization, told apart by their names. A provider's login is
-- named by the provider, so there is still one per provider.
DROP INDEX "Agent_orgId_providerId_key";

CREATE UNIQUE INDEX "Agent_orgId_providerId_name_key" ON "Agent"("orgId", "providerId", "name");
