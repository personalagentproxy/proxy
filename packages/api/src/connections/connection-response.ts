import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {ConnectionRow} from '@proxy/db/connection';
import {listMemberNames} from '@proxy/db/organization';
import type {Connection} from '@proxy/contracts/connections';

import {integrationOf} from '../utils/connection-actions';
import {needsSignIn, unavailableActions} from './unavailable';

type StoredConnectionRow = ConnectionRow & {credential: string | null};

function toConnection(row: StoredConnectionRow, connectedBy: string | null): Connection {
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
export function respondAll(rows: StoredConnectionRow[]): Promise<Result<Connection[], ApiError>> {
	return Do(async ($) => {
		const connectors = rows.flatMap((row) => (row.connectedById === null ? [] : [{orgId: row.orgId, userId: row.connectedById}]));
		const names = $(await listMemberNames(connectors));
		return rows.map((row) => {
			const connector = names.find((member) => member.orgId === row.orgId && member.userId === row.connectedById);
			return toConnection(row, connector?.name ?? null);
		});
	});
}

export function respond(row: StoredConnectionRow): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const [response] = $(await respondAll([row]));
		return $(requirePresent(response, ApiErr.notFound('connection', row.id)));
	});
}
