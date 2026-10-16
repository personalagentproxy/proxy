import type {AgentProviderId} from '@proxy/integrations';
import {z} from 'zod';
import {activitySummarySchema, agentSchema, auditEntrySchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';

export function listAgents() {
	return apiRequest('GET', '/api/agents', z.object({agents: z.array(agentSchema)}));
}

export function getAgent(agentId: string) {
	return apiRequest('GET', `/api/agents/${agentId}`, agentSchema);
}

/** The only time the password is sent; the api keeps its hash. */
export function createAgent(providerId: AgentProviderId) {
	return apiRequest('POST', '/api/agents', z.object({agent: agentSchema, password: z.string()}), {
		providerId,
	});
}

export function resetAgentPassword(agentId: string) {
	return apiRequest('POST', `/api/agents/${agentId}/password`, z.object({password: z.string()}));
}

export function setAgentRevoked(agentId: string, revoked: boolean) {
	return apiRequest('PUT', `/api/agents/${agentId}/revoked`, agentSchema, {revoked});
}

export function deleteAgent(agentId: string) {
	return apiSend('DELETE', `/api/agents/${agentId}`);
}

/** Sets the agent's own settings per action; `null` returns an action to the connection's default. */
export function setAgentGrants(
	agentId: string,
	connectionId: string,
	actions: Record<string, boolean | null>,
) {
	return apiRequest('PUT', `/api/agents/${agentId}/grants/${connectionId}`, agentSchema, {
		actions,
	});
}

const mcpClientSchema = z.object({id: z.string(), name: z.string(), connectedAt: z.string()});

export type McpClient = z.infer<typeof mcpClientSchema>;

/** The MCP clients, such as Claude, signed in as the agent. */
export function listMcpClients(agentId: string) {
	return apiRequest(
		'GET',
		`/api/agents/${agentId}/mcp-clients`,
		z.object({clients: z.array(mcpClientSchema)}),
	);
}

export function disconnectMcpClient(agentId: string, clientId: string) {
	return apiSend('DELETE', `/api/agents/${agentId}/mcp-clients/${clientId}`);
}

export type ActivityFilter = {
	agentId?: string;
	connectionId?: string;
	outcome?: 'allowed' | 'denied';
	// Only what was made from `from` until before `to`, ISO instants.
	from?: string;
	to?: string;
};

export function listActivity(filter: ActivityFilter) {
	const query = new URLSearchParams(
		Object.entries(filter).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const suffix = query.size > 0 ? `?${query}` : '';
	return apiRequest(
		'GET',
		`/api/activity${suffix}`,
		z.object({entries: z.array(auditEntrySchema)}),
	);
}

/** The home page's graph: each day's requests on the browser's clock, and the past week's by action. */
export function getActivitySummary(timeZone: string) {
	return apiRequest(
		'GET',
		`/api/activity/summary?${new URLSearchParams({timeZone})}`,
		activitySummarySchema,
	);
}
