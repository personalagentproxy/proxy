import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {createAgent, deleteAgent, getAgent, isUsernameConflict, listAgents, setAgentGrant, updateAgent} from '@proxy/db/agent';
import {getConnection} from '@proxy/db/connection';
import {ACCESS_LEVELS, findCollection, findIntegration, minAccess, providerAccess} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
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

const createAgentBodySchema = z.object({name: z.string().trim().min(1).max(80)});

/** The only time the password is sent; Personal Agent Proxy keeps its hash. A new agent follows every default. */
export function handleCreateAgentRoute(request: AuthenticatedRequest): Promise<Result<{agent: AgentResponse; password: string}, ApiError>> {
	return Do(async ($) => {
		const {name} = $(parseSchema(createAgentBodySchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const password = generatePassword();
		const passwordHash = await Bun.password.hash(password);

		for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
			const created = await createAgent({orgId, name, username: generateUsername(name), passwordHash});
			if (created.isOk()) {
				return {agent: toAgentResponse(created.value), password};
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

const setGrantBodySchema = z.object({access: z.enum(ACCESS_LEVELS).nullable()});

/**
 * Sets the agent's own access to a collection, or with `null` returns it to the connection's
 * default. Access above what the provider allows is refused with a conflict, as for defaults.
 */
export function handleSetAgentGrantRoute(request: AuthenticatedRequest): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const {access} = $(parseSchema(setGrantBodySchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const agentId = agentIdOf(request);
		const connectionId = request.params.connectionId ?? '';
		const collectionId = request.params.collectionId ?? '';
		$(await requireAgent(orgId, agentId));
		const connection = $(requirePresent($(await getConnection(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));

		const integration = findIntegration(connection.integrationId);
		const collection = integration && findCollection(integration, collectionId);
		if (!collection) {
			return $(Err(ApiErr.notFound('collection', collectionId)));
		}

		if (access !== null && minAccess(access, providerAccess(collection)) !== access) {
			return $(Err(ApiErr.conflict('The provider does not allow this access')));
		}

		$(await setAgentGrant({agentId, connectionId, collectionId, access}));
		return $(await requireAgent(orgId, agentId));
	});
}
