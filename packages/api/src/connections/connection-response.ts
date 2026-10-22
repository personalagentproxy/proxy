import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {ConnectionRow} from '@proxy/db/connection';
import {listMemberNames} from '@proxy/db/organization';
import type {McpTool} from '@proxy/integrations';

import {integrationOf} from '../utils/connection-actions';
import {needsSignIn, unavailableActions} from './unavailable';

export type ConnectionResponse = {
	id: string;
	// The organization it is in.
	orgId: string;
	integrationId: string;
	account: string;
	// Shared with every member of its organization, rather than one member's own.
	shared: boolean;
	// Who connected it, kept once it is shared; null for one from before it was kept.
	connectedById: string | null;
	// Their name, or else their address, while they are still in its organization.
	connectedBy: string | null;
	// The actions an agent without a setting of its own gets, in the catalog's order. An agent's own
	// settings live on the agent.
	defaults: string[];
	// A custom MCP server's tools, as the server last listed them: what its actions are. Null for
	// every other integration.
	tools: McpTool[] | null;
	// What the person called the connection, where they named it; null for every other integration,
	// which is called by its integration.
	name: string | null;
	// The actions the connection's sign-in didn't cover, in the catalog's order: no agent gets them
	// until the person signs in again and allows them.
	unavailable: string[];
	// The connection has no sign-in at all, as one moved over from a custom MCP server may not: every
	// action is unavailable until the person signs in.
	signInNeeded: boolean;
};

type StoredConnectionRow = ConnectionRow & {credential: string | null};

function toConnectionResponse(row: StoredConnectionRow, connectedBy: string | null): ConnectionResponse {
	const integration = integrationOf(row);
	const actions = integration?.actions ?? [];
	return {
		id: row.id,
		orgId: row.orgId,
		integrationId: row.integrationId,
		account: row.account,
		shared: row.ownerUserId === null,
		connectedById: row.connectedById,
		connectedBy,
		defaults: actions.map((action) => action.id).filter((id) => row.defaults.some((stored) => stored.actionId === id)),
		tools: integration?.mcpTools ?? null,
		name: row.name,
		unavailable: unavailableActions(row),
		signInNeeded: needsSignIn(row),
	};
}

/**
 * The connections as the web app gets them: with the actions their sign-in didn't cover, read from
 * their credentials on every request, and who connected each while they are still in its
 * organization.
 */
export function respondAll(rows: StoredConnectionRow[]): Promise<Result<ConnectionResponse[], ApiError>> {
	return Do(async ($) => {
		const connectors = rows.flatMap((row) => (row.connectedById === null ? [] : [{orgId: row.orgId, userId: row.connectedById}]));
		const names = $(await listMemberNames(connectors));
		return rows.map((row) => {
			const connector = names.find((member) => member.orgId === row.orgId && member.userId === row.connectedById);
			return toConnectionResponse(row, connector?.name ?? null);
		});
	});
}

export function respond(row: StoredConnectionRow): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const [response] = $(await respondAll([row]));
		return $(requirePresent(response, ApiErr.notFound('connection', row.id)));
	});
}
