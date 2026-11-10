import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {type Connection, type connectionListSchema, createVaultBodySchema, renameConnectionBodySchema, setDefaultsBodySchema, setSharingBodySchema} from '@proxy/contracts/connections';
import {createConnection, deleteConnection, listConnectionsWithCredential, setConnectionDefaults, setConnectionSharing, updateConnectionName} from '@proxy/db/connection';
import {listMembers} from '@proxy/db/organization';
import {VAULT_DEFAULT_ACTIONS, VAULT_INTEGRATION_ID} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {isBuiltIn, parseActionChanges, requireIntegration} from '../utils/connection-actions';
import {requireViewer} from '../utils/user-org';
import {ensureSandboxConnection} from '../native/sandbox/connections';
import {respond, respondAll} from './connection-response';
import {beforeDisconnect} from './disconnect';
import {requireConnection, requireManaged} from './managed';
import {ownership} from './ownership';
import {refuseUnavailable, unavailableActions} from './unavailable';

/** The connections the person uses in the organization they work in: their own and those shared with them. */
export function handleListConnectionsRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof connectionListSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		$(await ensureSandboxConnection(viewer));
		return {connections: $(await respondAll($(await listConnectionsWithCredential(viewer))))};
	});
}

export function handleGetConnectionRoute(request: AuthenticatedRequest): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		return $(await respond($(await requireConnection(viewer, request.params.connectionId ?? ''))));
	});
}

/**
 * Agents lose the connection at once, and the provider's grant is revoked first where it has a way,
 * as Google does. A vault a member made goes with its entries; their built-in vault and Sandboxes
 * can't be disconnected. A connection is disconnected by whoever's it is, or, shared with every
 * member, by the organization's owner.
 */
export function handleDeleteConnectionRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		if (isBuiltIn(row)) {
			return $(Err(ApiErr.forbidden()));
		}

		await beforeDisconnect(row);
		const deleted = $(await deleteConnection(viewer, connectionId));
		if (!deleted) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
	});
}

/**
 * Renames a connection, `{name}`: what it is called here and to agents. An empty name is none of
 * its own, so the connection shows as its integration again, except for a custom MCP server, which
 * and a vault a member made, which have nothing else to be called. A built-in connection keeps its
 * name.
 */
export function handleRenameConnectionRoute(request: AuthenticatedRequest): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		const integration = $(requireIntegration(row));
		if (isBuiltIn(row)) {
			return $(Err(ApiErr.forbidden()));
		}
		const {name} = $(parseSchema(renameConnectionBodySchema, request.body));
		if (name === '' && integration.custom) {
			return $(Err(ApiErr.validationError('A custom MCP server needs a name')));
		}
		if (name === '' && integration.native) {
			return $(Err(ApiErr.validationError(`A ${integration.name.toLowerCase()} needs a name`)));
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
export function handleSetConnectionDefaultsRoute(request: AuthenticatedRequest): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		const integration = $(requireIntegration(row));
		const actions = $(parseActionChanges(integration, setDefaultsBodySchema, request.body));
		$(refuseUnavailable(integration, unavailableActions(row), actions));

		$(await setConnectionDefaults({connectionId, actions}));
		return $(await respond($(await requireConnection(viewer, connectionId))));
	});
}

/**
 * `PUT /api/orgs/:org/connections/:connectionId/sharing`: who the connection is shared with,
 * `{everyone, userIds}`, all of it at once: every member of the organization, the members named,
 * both or nobody; whoever is left out loses it at once, with what their agents were set to do with
 * it. Set by whoever's it is, or, while it is shared with every member, by the organization's
 * owner. The members named are in the organization; its owner needn't be told it is theirs. A
 * built-in connection is each member's own and stays so.
 */
export function handleSetConnectionSharingRoute(request: AuthenticatedRequest): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(await requireManaged(viewer, connectionId));
		if (isBuiltIn(row)) {
			return $(Err(ApiErr.forbidden()));
		}
		const {everyone, userIds} = $(parseSchema(setSharingBodySchema, request.body));
		const members = new Set($(await listMembers(viewer.orgId)).map((member) => member.userId));
		const outsider = userIds.find((userId) => !members.has(userId));
		if (outsider !== undefined) {
			return $(Err(ApiErr.validationError('A connection is shared with members of its organization')));
		}
		const named = [...new Set(userIds)].filter((userId) => userId !== row.ownerUserId);

		$(await setConnectionSharing({connectionId, ownerUserId: row.ownerUserId, everyone, userIds: named}));
		return $(await respond({...row, sharedWithEveryone: everyone, shares: named.map((userId) => ({userId}))}));
	});
}

/**
 * `POST /api/orgs/:org/connections/vault`: a new vault, `{name, shared}`, beside the person's
 * built-in one: theirs, to keep what a few of them or everyone should know, shared as any
 * connection. Agents read and write it by default, as every vault.
 */
export function handleCreateVaultRoute(request: AuthenticatedRequest): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const {name, shared} = $(parseSchema(createVaultBodySchema, request.body));
		const row = $(
			await createConnection({
				...ownership(viewer, shared === true),
				integrationId: VAULT_INTEGRATION_ID,
				account: viewer.name,
				name,
				defaults: VAULT_DEFAULT_ACTIONS,
			}),
		);
		return $(await respond({...row, credential: null}));
	});
}
