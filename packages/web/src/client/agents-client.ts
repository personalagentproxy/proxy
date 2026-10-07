import type {Access, AgentProviderId} from '@proxy/integrations';
import {z} from 'zod';
import {agentSchema, auditEntrySchema} from '@/client/schemas';
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

/** `null` returns the agent to the connection's default. */
export function setAgentGrant(
	agentId: string,
	connectionId: string,
	collectionId: string,
	access: Access | null,
) {
	return apiRequest(
		'PUT',
		`/api/agents/${agentId}/grants/${connectionId}/${collectionId}`,
		agentSchema,
		{access},
	);
}

export function listActivity(filter: {agentId?: string; connectionId?: string}) {
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
