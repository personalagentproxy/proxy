import type {AgentProviderId} from '@proxy/integrations';
import {z} from 'zod';
import {
	activityLanesSchema,
	activityTaskSchema,
	agentSchema,
	auditEntrySchema,
} from '@/client/schemas';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// Every call is about one organization, by its slug (`org`), as its address in the app names it.

/** The agents the person sees in the organization: its shared ones and their own. */
export function listAgents(org: string) {
	return apiRequest('GET', `${orgApi(org)}/agents`, z.object({agents: z.array(agentSchema)}));
}

export function getAgent(org: string, agentId: string) {
	return apiRequest('GET', `${orgApi(org)}/agents/${agentId}`, agentSchema);
}

/** The only time the password is sent; the api keeps its hash. `shared` makes the agent every member's rather than the person's own. */
export function createAgent(org: string, providerId: AgentProviderId, shared = false) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/agents`,
		z.object({agent: agentSchema, password: z.string()}),
		{providerId, ...(shared ? {shared} : {})},
	);
}

/** Shares one's own agent with every member of its organization, for good. */
export function shareAgent(org: string, agentId: string) {
	return apiRequest('POST', `${orgApi(org)}/agents/${agentId}/share`, agentSchema);
}

export function resetAgentPassword(org: string, agentId: string) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/agents/${agentId}/password`,
		z.object({password: z.string()}),
	);
}

export function setAgentRevoked(org: string, agentId: string, revoked: boolean) {
	return apiRequest('PUT', `${orgApi(org)}/agents/${agentId}/revoked`, agentSchema, {revoked});
}

export function deleteAgent(org: string, agentId: string) {
	return apiSend('DELETE', `${orgApi(org)}/agents/${agentId}`);
}

/** Sets the agent's own settings per action; `null` returns an action to the connection's default. */
export function setAgentGrants(
	org: string,
	agentId: string,
	connectionId: string,
	actions: Record<string, boolean | null>,
) {
	return apiRequest('PUT', `${orgApi(org)}/agents/${agentId}/grants/${connectionId}`, agentSchema, {
		actions,
	});
}

const mcpClientSchema = z.object({id: z.string(), name: z.string(), connectedAt: z.string()});

export type McpClient = z.infer<typeof mcpClientSchema>;

/** The MCP clients, such as Claude, signed in as the agent. */
export function listMcpClients(org: string, agentId: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/agents/${agentId}/mcp-clients`,
		z.object({clients: z.array(mcpClientSchema)}),
	);
}

export function disconnectMcpClient(org: string, agentId: string, clientId: string) {
	return apiSend('DELETE', `${orgApi(org)}/agents/${agentId}/mcp-clients/${clientId}`);
}

export type ActivityFilter = {
	agentId?: string;
	connectionId?: string;
	// One task's requests.
	taskId?: string;
	outcome?: 'allowed' | 'denied';
};

export function listActivity(org: string, filter: ActivityFilter) {
	const query = new URLSearchParams(
		Object.entries(filter).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const suffix = query.size > 0 ? `?${query}` : '';
	return apiRequest(
		'GET',
		`${orgApi(org)}/activity${suffix}`,
		z.object({entries: z.array(auditEntrySchema), tasks: z.array(activityTaskSchema)}),
	);
}

/** The home page's lanes: every task under way at some point since `from`, an ISO instant, with what was done for each. */
export function getActivityLanes(org: string, from: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/activity/lanes?${new URLSearchParams({from})}`,
		activityLanesSchema,
	);
}
