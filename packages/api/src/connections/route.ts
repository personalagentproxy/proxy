import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {deleteConnection, listConnectionsWithCredential, setConnectionDefaults, shareConnection, updateConnectionName} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {integrationOf, parseActionChanges, requireIntegration} from '../utils/connection-actions';
import {requireViewer} from '../utils/user-org';
import {respond, respondAll, type ConnectionResponse} from './connection-response';
import {beforeDisconnect} from './disconnect';
import {requireConnection, requireManaged} from './managed';
import {refuseUnavailable, unavailableActions} from './unavailable';

/** The connections the person sees in the organization they work in: its shared ones and their own. */
export function handleListConnectionsRoute(request: AuthenticatedRequest): Promise<Result<{connections: ConnectionResponse[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		return {connections: $(await respondAll($(await listConnectionsWithCredential(viewer))))};
	});
}

export function handleGetConnectionRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		return $(await respond($(await requireConnection(viewer, request.params.connectionId ?? ''))));
	});
}

/**
 * Agents lose the connection at once, and the provider's grant is revoked first where it has a way,
 * as Google does. The vault is built in and can't be disconnected. A shared connection is
 * disconnected by whoever connected it or the organization's owner.
 */
export function handleDeleteConnectionRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		if (integrationOf(row)?.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}

		await beforeDisconnect(row);
		const deleted = $(await deleteConnection(viewer, connectionId));
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
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		const integration = $(requireIntegration(row));
		if (integration.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}
		const {name} = $(parseSchema(renameBodySchema, request.body));
		if (name === '' && integration.custom) {
			return $(Err(ApiErr.validationError('A custom MCP server needs a name')));
		}

		$(await updateConnectionName({connectionId, name: name === '' ? null : name}));
		return $(await respond({...row, name: name === '' ? null : name}));
	});
}

/**
 * Turns actions on or off for every agent without a setting of its own, such as
 * `{actions: {read: true, send: false}}`. An action the integration doesn't have is refused, and so
 * is turning on one the connection's sign-in didn't cover.
 */
export function handleSetConnectionDefaultsRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		const integration = $(requireIntegration(row));
		const actions = $(parseActionChanges(integration, z.boolean(), request.body));
		$(refuseUnavailable(integration, unavailableActions(row), actions));

		$(await setConnectionDefaults({connectionId, actions}));
		return $(await respond($(await requireConnection(viewer, connectionId))));
	});
}

/**
 * `POST /api/connections/:connectionId/share`: shares the person's own connection with every member
 * of its organization, for good: to have it as their own again, they disconnect it and connect it
 * again. The vault is each member's own and stays so.
 */
export function handleShareConnectionRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		if (integrationOf(row)?.builtIn) {
			return $(Err(ApiErr.forbidden()));
		}
		$(await shareConnection(connectionId));
		return $(await respond({...row, ownerUserId: null}));
	});
}
