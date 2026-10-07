import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {deleteConnection, getConnection, listConnections, setConnectionDefaults} from '@proxy/db/connection';
import {findIntegration} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {parseActionChanges, requireIntegration} from '../utils/connection-actions';
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
		if (findIntegration(row.integrationId)?.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}

		const deleted = $(await deleteConnection(orgId, connectionId));
		if (!deleted) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
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
		const integration = $(requireIntegration(row.integrationId));
		const actions = $(parseActionChanges(integration, z.boolean(), request.body));

		$(await setConnectionDefaults({connectionId, actions}));
		const updated = $(await getConnection(orgId, connectionId));
		return toConnectionResponse($(requirePresent(updated, ApiErr.notFound('connection', connectionId))));
	});
}
