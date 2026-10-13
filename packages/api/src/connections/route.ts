import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {deleteConnection, getConnection, listConnections, setConnectionDefaults, updateConnectionName} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {integrationOf, parseActionChanges, requireIntegration} from '../utils/connection-actions';
import {requireUserOrgId} from '../utils/user-org';
import {toConnectionResponse, type ConnectionResponse} from './connection-response';

export function handleListConnectionsRoute(request: AuthenticatedRequest): Promise<Result<{connections: ConnectionResponse[]}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const rows = $(await listConnections(orgId));
		return {connections: rows.map(toConnectionResponse)};
	});
}

export function handleGetConnectionRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await getConnection(orgId, connectionId));
		return toConnectionResponse($(requirePresent(row, ApiErr.notFound('connection', connectionId))));
	});
}

/** Agents lose the connection at once. Information is built in and can't be disconnected. */
export function handleDeleteConnectionRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(requirePresent($(await getConnection(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		if (integrationOf(row)?.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}

		const deleted = $(await deleteConnection(orgId, connectionId));
		if (!deleted) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
	});
}

const MAX_NAME_LENGTH = 80;

const renameBodySchema = z.object({name: z.string().trim().max(MAX_NAME_LENGTH, `The name can be at most ${MAX_NAME_LENGTH} characters`)});

/**
 * Renames a connection, `{name}`: what it is called here and to agents. An empty name is none of
 * its own, so the connection shows as its integration again, except for a custom MCP server, which
 * has nothing else to be called. Information is built in and keeps its name.
 */
export function handleRenameConnectionRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(requirePresent($(await getConnection(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		const integration = $(requireIntegration(row));
		if (integration.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}
		const {name} = $(parseSchema(renameBodySchema, request.body));
		if (name === '' && integration.custom) {
			return $(Err(ApiErr.validationError('A custom MCP server needs a name')));
		}

		$(await updateConnectionName({connectionId, name: name === '' ? null : name}));
		return toConnectionResponse({...row, name: name === '' ? null : name});
	});
}

/**
 * Turns actions on or off for every agent without a setting of its own, such as
 * `{actions: {read: true, send: false}}`. An action the integration doesn't have is refused.
 */
export function handleSetConnectionDefaultsRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(requirePresent($(await getConnection(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		const integration = $(requireIntegration(row));
		const actions = $(parseActionChanges(integration, z.boolean(), request.body));

		$(await setConnectionDefaults({connectionId, actions}));
		const updated = $(await getConnection(orgId, connectionId));
		return toConnectionResponse($(requirePresent(updated, ApiErr.notFound('connection', connectionId))));
	});
}
