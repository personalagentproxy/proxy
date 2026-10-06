import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {deleteConnection, getConnection, listConnections, setConnectionDefault} from '@proxy/db/connection';
import {ACCESS_LEVELS, findCollection, findIntegration, minAccess, providerAccess} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
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

/** Agents lose the connection at once. Disconnecting doesn't revoke anything at the provider yet. */
export function handleDeleteConnectionRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const deleted = $(await deleteConnection(orgId, connectionId));
		if (!deleted) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
	});
}

const setDefaultBodySchema = z.object({access: z.enum(ACCESS_LEVELS)});

/**
 * Sets what an agent without a setting of its own can do in a collection. A default above what
 * the provider allows, such as writing received emails, is refused with a conflict.
 */
export function handleSetConnectionDefaultRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const {access} = $(parseSchema(setDefaultBodySchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const collectionId = request.params.collectionId ?? '';
		const row = $(requirePresent($(await getConnection(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));

		const integration = findIntegration(row.integrationId);
		const collection = integration && findCollection(integration, collectionId);
		if (!collection) {
			return $(Err(ApiErr.notFound('collection', collectionId)));
		}

		if (minAccess(access, providerAccess(collection)) !== access) {
			return $(Err(ApiErr.conflict('The provider does not allow this access')));
		}

		$(await setConnectionDefault({connectionId, collectionId, access}));
		const updated = $(await getConnection(orgId, connectionId));
		return toConnectionResponse($(requirePresent(updated, ApiErr.notFound('connection', connectionId))));
	});
}
