import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {createAgent, deleteAgent, getAgent, isProviderConflict, isUsernameConflict, listAgents, setAgentGrants, updateAgent} from '@proxy/db/agent';
import {getConnection} from '@proxy/db/connection';
import {findAgentProvider} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {parseActionChanges, requireIntegration} from '../utils/connection-actions';
import {requireUserOrgId} from '../utils/user-org';
import {toAgentResponse, type AgentResponse} from './agent-response';
import {generatePassword, generateUsername} from './credentials';

const MAX_USERNAME_ATTEMPTS = 5;

function agentIdOf(request: AuthenticatedRequest): string {
	return request.params.agentId ?? '';
}

async function requireAgent(orgId: string, agentId: string): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const row = $(await getAgent(orgId, agentId));
		return toAgentResponse($(requirePresent(row, ApiErr.notFound('agent', agentId))));
	});
}

export function handleListAgentsRoute(request: AuthenticatedRequest): Promise<Result<{agents: AgentResponse[]}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		return {agents: $(await listAgents(orgId)).map(toAgentResponse)};
	});
}

export function handleGetAgentRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		return $(await requireAgent(orgId, agentIdOf(request)));
	});
}

const createAgentBodySchema = z.object({providerId: z.string()});

/** The only time the password is sent; Personal Agent Proxy keeps its hash. A new agent follows every default. */
export function handleCreateAgentRoute(request: AuthenticatedRequest): Promise<Result<{agent: AgentResponse; password: string}, ApiError>> {
	return Do(async ($) => {
		const {providerId} = $(parseSchema(createAgentBodySchema, request.body));
		const provider = $(requirePresent(findAgentProvider(providerId), ApiErr.parseError(`Unknown agent ${providerId}`)));
		const orgId = $(await requireUserOrgId(request));
		const password = generatePassword();
		const passwordHash = await Bun.password.hash(password);

		for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
			const created = await createAgent({orgId, providerId: provider.id, name: provider.name, username: generateUsername(provider.name), passwordHash});
			if (created.isOk()) {
				return {agent: toAgentResponse(created.value), password};
			}
			if (isProviderConflict(created.error)) {
				return $(Err(ApiErr.conflict(`${provider.name} already has an agent login`)));
			}
			if (!isUsernameConflict(created.error)) {
				return $(created);
			}
		}
		return $(Err(ApiErr.internalError(new Error('Username retries exhausted'))));
	});
}

/** A new password, sent this once; the old one stops working. */
export function handleResetAgentPasswordRoute(request: AuthenticatedRequest): Promise<Result<{password: string}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const password = generatePassword();
		const updated = $(await updateAgent(orgId, agentIdOf(request), {passwordHash: await Bun.password.hash(password)}));
		if (!updated) {
			return $(Err(ApiErr.notFound('agent', agentIdOf(request))));
		}
		return {password};
	});
}

const setRevokedBodySchema = z.object({revoked: z.boolean()});

/** A revoked agent can't sign in, and is shown nothing it could reach before. */
export function handleSetAgentRevokedRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const {revoked} = $(parseSchema(setRevokedBodySchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const updated = $(await updateAgent(orgId, agentIdOf(request), {revokedAt: revoked ? new Date() : null}));
		if (!updated) {
			return $(Err(ApiErr.notFound('agent', agentIdOf(request))));
		}
		return $(await requireAgent(orgId, agentIdOf(request)));
	});
}

export function handleDeleteAgentRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const deleted = $(await deleteAgent(orgId, agentIdOf(request)));
		if (!deleted) {
			return $(Err(ApiErr.notFound('agent', agentIdOf(request))));
		}
	});
}

/**
 * Sets the agent's own settings for actions of a connection, such as `{actions: {send: false}}`;
 * `null` returns an action to the connection's default. An action the integration doesn't have is
 * refused.
 */
export function handleSetAgentGrantsRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const agentId = agentIdOf(request);
		const connectionId = request.params.connectionId ?? '';
		$(await requireAgent(orgId, agentId));
		const connection = $(requirePresent($(await getConnection(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		const integration = $(requireIntegration(connection.integrationId));
		const actions = $(parseActionChanges(integration, z.boolean().nullable(), request.body));

		$(await setAgentGrants({agentId, connectionId, actions}));
		return $(await requireAgent(orgId, agentId));
	});
}
