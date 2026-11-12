import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {ConnectionRow} from '@proxy/db/connection';
import {listMemberNames} from '@proxy/db/organization';
import type {Connection} from '@proxy/contracts/connections';

import {integrationOf, isBuiltIn} from '../utils/connection-actions';
import {needsSignIn, unavailableActions} from './unavailable';

type StoredConnectionRow = ConnectionRow & {credential: string | null};

// What members are called, by their id.
type Names = Map<string, string>;

function toConnection(row: StoredConnectionRow, names: Names): Connection {
	const integration = integrationOf(row);
	const actions = integration?.actions ?? [];
	// Someone it is shared with is in its organization: leaving takes what was shared with them.
	const sharedWith = row.shares.flatMap(({userId}) => {
		const name = names.get(userId);
		return name === undefined ? [] : [{userId, name}];
	});
	return {
		id: row.id,
		orgId: row.orgId,
		integrationId: row.integrationId,
		account: row.account,
		ownerUserId: row.ownerUserId,
		owner: names.get(row.ownerUserId) ?? null,
		sharedWithEveryone: row.sharedWithEveryone,
		sharedWith,
		shared: row.sharedWithEveryone || sharedWith.length > 0,
		builtIn: isBuiltIn(row),
		defaults: actions.map((action) => action.id).filter((id) => row.defaults.some((stored) => stored.actionId === id)),
		tools: integration?.mcpTools ?? null,
		name: row.name,
		health:
			row.healthStatus && row.healthMessage && row.healthCheckedAt
				? {
						status: row.healthStatus,
						message: row.healthMessage,
						checkedAt: row.healthCheckedAt.toISOString(),
					}
				: null,
		unavailable: unavailableActions(row),
		signInNeeded: needsSignIn(row),
	};
}

/**
 * The connections of one organization as the web app gets them: with the actions their sign-in
 * didn't cover, read from their credentials on every request, and whose each is and who it is
 * shared with, by name.
 */
export function respondAll(rows: StoredConnectionRow[]): Promise<Result<Connection[], ApiError>> {
	return Do(async ($) => {
		const people = rows.flatMap((row) => [row.ownerUserId, ...row.shares.map((share) => share.userId)].map((userId) => ({orgId: row.orgId, userId})));
		const names: Names = new Map($(await listMemberNames(people)).map((member) => [member.userId, member.name]));
		return rows.map((row) => toConnection(row, names));
	});
}

export function respond(row: StoredConnectionRow): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const [response] = $(await respondAll([row]));
		return $(requirePresent(response, ApiErr.notFound('connection', row.id)));
	});
}
