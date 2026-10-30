import {
	activityListSchema,
	activityTimelineSchema,
	taskRunSchema,
	type ActivityFilter,
} from '@proxy/contracts/activity';
import {
	agentListSchema,
	agentPasswordSchema,
	agentSchema,
	type createAgentBodySchema,
	createdAgentSchema,
	mcpClientListSchema,
	type renameAgentBodySchema,
	type setGrantsBodySchema,
	type setRevokedBodySchema,
} from '@proxy/contracts/agents';
import type {AgentProviderId} from '@proxy/utils/agent-providers';
import type {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// Every call is about one organization, by its slug (`org`), as its address in the app names it.

/** The agents the person sees in the organization: its shared ones and their own. */
export function listAgents(org: string) {
	return apiRequest('GET', `${orgApi(org)}/agents`, agentListSchema);
}

export function getAgent(org: string, agentId: string) {
	return apiRequest('GET', `${orgApi(org)}/agents/${agentId}`, agentSchema);
}

/** The only time the password is sent; the api keeps its hash. `shared` makes the agent every member's rather than the person's own. */
export function createAgent(
	org: string,
	providerId: AgentProviderId,
	options: {name: string; shared: boolean},
) {
	return apiRequest('POST', `${orgApi(org)}/agents`, createdAgentSchema, {
		providerId,
		name: options.name,
		...(options.shared ? {shared: true} : {}),
	} satisfies z.input<typeof createAgentBodySchema>);
}

/** Shares one's own agent with every member of its organization, for good. */
export function shareAgent(org: string, agentId: string) {
	return apiRequest('POST', `${orgApi(org)}/agents/${agentId}/share`, agentSchema);
}

/** Renames an agent: what it is called here, in the activity log and to the agent itself. */
export function renameAgent(org: string, agentId: string, name: string) {
	return apiRequest('PUT', `${orgApi(org)}/agents/${agentId}/name`, agentSchema, {
		name,
	} satisfies z.input<typeof renameAgentBodySchema>);
}

export function resetAgentPassword(org: string, agentId: string) {
	return apiRequest('POST', `${orgApi(org)}/agents/${agentId}/password`, agentPasswordSchema);
}

export function setAgentRevoked(org: string, agentId: string, revoked: boolean) {
	return apiRequest('PUT', `${orgApi(org)}/agents/${agentId}/revoked`, agentSchema, {
		revoked,
	} satisfies z.input<typeof setRevokedBodySchema>);
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
	} satisfies z.input<typeof setGrantsBodySchema>);
}

/** The MCP clients, such as Claude, signed in as the agent. */
export function listMcpClients(org: string, agentId: string) {
	return apiRequest('GET', `${orgApi(org)}/agents/${agentId}/mcp-clients`, mcpClientListSchema);
}

export function disconnectMcpClient(org: string, agentId: string, clientId: string) {
	return apiSend('DELETE', `${orgApi(org)}/agents/${agentId}/mcp-clients/${clientId}`);
}

export function listActivity(org: string, filter: ActivityFilter) {
	const query = new URLSearchParams(
		Object.entries(filter).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const suffix = query.size > 0 ? `?${query}` : '';
	return apiRequest('GET', `${orgApi(org)}/activity${suffix}`, activityListSchema);
}

/** A task's page: the task, its sub-tasks at every depth, and every request made for them. */
export function getTaskRun(org: string, taskId: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/activity/tasks/${encodeURIComponent(taskId)}`,
		taskRunSchema,
	);
}

/**
 * The home page's timeline: every task under way at some point between `from` and `to`, ISO
 * instants, or since `from` without `to`, with its sub-tasks and the requests made for them.
 */
export function getActivityTimeline(org: string, from: string, to?: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/activity/timeline?${new URLSearchParams({from, ...(to === undefined ? {} : {to})})}`,
		activityTimelineSchema,
	);
}
