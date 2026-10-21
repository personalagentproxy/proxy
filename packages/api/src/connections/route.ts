import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {deleteConnection, getConnectionWithCredential, listConnectionsWithCredential, setConnectionDefaults, updateConnectionName, type ConnectionRow} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {integrationOf, parseActionChanges, requireIntegration} from '../utils/connection-actions';
import {requireUserOrgId} from '../utils/user-org';
import {toConnectionResponse, type ConnectionResponse} from './connection-response';
import {beforeDisconnect} from './disconnect';
import {needsSignIn, refuseUnavailable, unavailableActions} from './unavailable';

type StoredConnectionRow = ConnectionRow & {credential: string | null};

// The connection as the web app gets it, with the actions its sign-in didn't cover, read from its
// credential on every request.
function respond(row: StoredConnectionRow): ConnectionResponse {
	return toConnectionResponse(row, unavailableActions(row), needsSignIn(row));
}

function requireConnection(orgId: string, connectionId: string): Promise<Result<StoredConnectionRow, ApiError>> {
	return Do(async ($) => {
		return $(requirePresent($(await getConnectionWithCredential(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
	});
}

export function handleListConnectionsRoute(request: AuthenticatedRequest): Promise<Result<{connections: ConnectionResponse[]}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const rows = $(await listConnectionsWithCredential(orgId));
		return {connections: rows.map(respond)};
	});
}

export function handleGetConnectionRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		return respond($(await requireConnection(orgId, request.params.connectionId ?? '')));
	});
}

/**
 * Agents lose the connection at once, and the provider's grant is revoked first where it has a way,
 * as Google does. The vault is built in and can't be disconnected.
 */
export function handleDeleteConnectionRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireConnection(orgId, connectionId));
		if (integrationOf(row)?.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}

		await beforeDisconnect(row);
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
 * has nothing else to be called. The vault is built in and keeps its name.
 */
export function handleRenameConnectionRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireConnection(orgId, connectionId));
		const integration = $(requireIntegration(row));
		if (integration.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}
		const {name} = $(parseSchema(renameBodySchema, request.body));
		if (name === '' && integration.custom) {
			return $(Err(ApiErr.validationError('A custom MCP server needs a name')));
		}

		$(await updateConnectionName({connectionId, name: name === '' ? null : name}));
		return respond({...row, name: name === '' ? null : name});
	});
}

/**
 * Turns actions on or off for every agent without a setting of its own, such as
 * `{actions: {read: true, send: false}}`. An action the integration doesn't have is refused, and so
 * is turning on one the connection's sign-in didn't cover.
 */
export function handleSetConnectionDefaultsRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireConnection(orgId, connectionId));
		const integration = $(requireIntegration(row));
		const actions = $(parseActionChanges(integration, z.boolean(), request.body));
		$(refuseUnavailable(integration, unavailableActions(row), actions));

		$(await setConnectionDefaults({connectionId, actions}));
		return respond($(await requireConnection(orgId, connectionId)));
	});
}
