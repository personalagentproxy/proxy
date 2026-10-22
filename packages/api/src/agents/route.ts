import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {deleteAgent, getAgent, listAgents, setAgentGrants, shareAgent, updateAgent, type AgentRow, type AgentViewer} from '@proxy/db/agent';
import {getConnectionWithCredential} from '@proxy/db/connection';
import {deleteOAuthGrant, listAgentOAuthGrants} from '@proxy/db/oauth';

import {refuseUnavailable, unavailableActions} from '../connections/unavailable';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {parseActionChanges, requireIntegration} from '../utils/connection-actions';
import {requireViewer, type OrgViewer} from '../utils/user-org';
import {respond, respondAll, type AgentResponse} from './agent-response';
import {createAgentLogin} from './create-agent-login';
import {generatePassword} from './credentials';

// An agent is a member's own, which nobody else in the organization sees, or shared with every
// member of it. A shared one is changed, revoked, deleted and given its settings by whoever made it
// and the organization's owner; everyone else sees it as it is.

function agentIdOf(request: AuthenticatedRequest): string {
	return request.params.agentId ?? '';
}

/** An agent the viewer sees: not found for any other. */
function requireAgent(viewer: AgentViewer, agentId: string): Promise<Result<AgentRow, ApiError>> {
	return Do(async ($) => {
		return $(requirePresent($(await getAgent(viewer, agentId)), ApiErr.notFound('agent', agentId)));
	});
}

/** An agent the viewer may change: their own, or a shared one they made or whose organization they own. */
function requireManagedAgent(viewer: OrgViewer, agentId: string): Promise<Result<AgentRow, ApiError>> {
	return Do(async ($) => {
		const row = $(await requireAgent(viewer, agentId));
		if (row.ownerUserId !== null || row.createdById === viewer.userId || viewer.role === 'owner') {
			return row;
		}
		return $(Err(ApiErr.forbidden()));
	});
}

/** The agents the person sees in the organization they work in: its shared ones and their own. */
export function handleListAgentsRoute(request: AuthenticatedRequest): Promise<Result<{agents: AgentResponse[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		return {agents: $(await respondAll($(await listAgents(viewer))))};
	});
}

export function handleGetAgentRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		return $(await respond($(await requireAgent(viewer, agentIdOf(request)))));
	});
}

// A custom agent's name is the person's; every other agent is named by its provider. `shared` makes
// it every member's rather than the person's own.
const createAgentBodySchema = z.object({providerId: z.string(), name: z.string().optional(), shared: z.boolean().optional()});

/** The only time the password is sent; Personal Agent Proxy keeps its hash. A new agent follows every default. */
export function handleCreateAgentRoute(request: AuthenticatedRequest): Promise<Result<{agent: AgentResponse; password: string}, ApiError>> {
	return Do(async ($) => {
		const {providerId, name, shared} = $(parseSchema(createAgentBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		const {agent, password} = $(await createAgentLogin(viewer, providerId, {name, shared}));
		return {agent: $(await respond(agent)), password};
	});
}

/** A new password, sent this once; the old one stops working. */
export function handleResetAgentPasswordRoute(request: AuthenticatedRequest): Promise<Result<{password: string}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const agent = $(await requireManagedAgent(viewer, agentIdOf(request)));
		const password = generatePassword();
		const updated = $(await updateAgent(viewer.orgId, agent.id, {passwordHash: await Bun.password.hash(password)}));
		if (!updated) {
			return $(Err(ApiErr.notFound('agent', agent.id)));
		}
		return {password};
	});
}

const setRevokedBodySchema = z.object({revoked: z.boolean()});

/** A revoked agent can't sign in, and is shown nothing it could reach before. */
export function handleSetAgentRevokedRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const {revoked} = $(parseSchema(setRevokedBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		const agent = $(await requireManagedAgent(viewer, agentIdOf(request)));
		const updated = $(await updateAgent(viewer.orgId, agent.id, {revokedAt: revoked ? new Date() : null}));
		if (!updated) {
			return $(Err(ApiErr.notFound('agent', agent.id)));
		}
		return $(await respond($(await requireAgent(viewer, agent.id))));
	});
}

export function handleDeleteAgentRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const agent = $(await requireManagedAgent(viewer, agentIdOf(request)));
		const deleted = $(await deleteAgent(viewer.orgId, agent.id));
		if (!deleted) {
			return $(Err(ApiErr.notFound('agent', agent.id)));
		}
	});
}

/**
 * `POST /api/agents/:agentId/share`: shares the person's own agent with every member of its
 * organization, for good: it reaches the shared connections alone from then on, so its settings on
 * the person's own connections go.
 */
export function handleShareAgentRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const agent = $(await requireManagedAgent(viewer, agentIdOf(request)));
		$(await shareAgent(agent.id));
		return $(await respond($(await requireAgent(viewer, agent.id))));
	});
}

/**
 * Sets the agent's own settings for actions of a connection, such as `{actions: {send: false}}`;
 * `null` returns an action to the connection's default. An action the integration doesn't have is
 * refused, and so is turning on one the connection's sign-in didn't cover. A shared agent reaches
 * only shared connections, so a setting on one's own connection is refused for it.
 */
export function handleSetAgentGrantsRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const agentId = agentIdOf(request);
		const connectionId = request.params.connectionId ?? '';
		const agent = $(await requireManagedAgent(viewer, agentId));
		const connection = $(requirePresent($(await getConnectionWithCredential(viewer, connectionId)), ApiErr.notFound('connection', connectionId)));
		if (agent.ownerUserId === null && connection.ownerUserId !== null) {
			return $(Err(ApiErr.validationError('A shared agent reaches only shared connections')));
		}
		const integration = $(requireIntegration(connection));
		const actions = $(parseActionChanges(integration, z.boolean().nullable(), request.body));
		$(refuseUnavailable(integration, unavailableActions(connection), actions));

		$(await setAgentGrants({agentId, connectionId, actions}));
		return $(await respond($(await requireAgent(viewer, agentId))));
	});
}

export type McpClientResponse = {id: string; name: string; connectedAt: string};

/** The MCP clients signed in as the agent, such as Claude, newest first; for whoever may change the agent. */
export function handleListMcpClientsRoute(request: AuthenticatedRequest): Promise<Result<{clients: McpClientResponse[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const agent = $(await requireManagedAgent(viewer, agentIdOf(request)));
		const grants = $(await listAgentOAuthGrants(viewer.orgId, agent.id));
		return {clients: grants.map((grant) => ({id: grant.id, name: grant.clientName, connectedAt: grant.createdAt.toISOString()}))};
	});
}

/** Signs one MCP client out of the agent; it has to be connected again. */
export function handleDisconnectMcpClientRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const agent = $(await requireManagedAgent(viewer, agentIdOf(request)));
		const grantId = request.params.grantId ?? '';
		const deleted = $(await deleteOAuthGrant(viewer.orgId, agent.id, grantId));
		if (!deleted) {
			return $(Err(ApiErr.notFound('MCP client', grantId)));
		}
	});
}
