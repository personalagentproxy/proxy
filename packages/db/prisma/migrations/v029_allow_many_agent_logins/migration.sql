-- A person or an organization can have any number of logins of a provider, each with a name of its
-- own, so nothing about an agent but its username is unique.
DROP INDEX "Agent_orgId_ownerUserId_providerId_name_key";
