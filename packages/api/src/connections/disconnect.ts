import {type ApiError, Do} from '@proxy/utils';
import {countSameAccountConnections} from '@proxy/db/connection';

import {log, serializeError} from '../observability/log';
import {readGoogleCredential, revokeGoogleTokens} from './google/google-oauth';
import {removeItem} from './plaid/plaid-api';
import {readPlaidCredential, requirePlaidClient} from './plaid/plaid-client';

/**
 * What is undone at the provider before a connection is deleted, where the provider has a way.
 * Google's grant is revoked, so its tokens stop working there too. A grant is the account's for the
 * app's Google client as a whole, every refresh token it has, so it is kept while another
 * connection, in this organization or any other, is for the same account, by Google's id for it or
 * its address. A Plaid bank login is removed at Plaid, which also ends what Plaid bills for it; each
 * connection is a login of its own. A failure is logged and the connection is deleted anyway; the
 * person can still revoke Google's at myaccount.google.com/permissions, and Plaid's at my.plaid.com.
 */

type DisconnectedConnection = {id: string; integrationId: string; account: string; credential: string | null};

// `going` are the connections being deleted along with this one, this one included: what is for
// the same account among them doesn't keep the grant.
function revokeGoogle(connection: DisconnectedConnection, going: string[]) {
	return Do<void, ApiError>(async ($) => {
		const others = $(await countSameAccountConnections(connection.id, going));
		if (others > 0) {
			log.info('Kept the Google grant another connection uses', {connectionId: connection.id});
			return;
		}
		$(await revokeGoogleTokens($(readGoogleCredential(connection.credential))));
	});
}

function removePlaidItem(connection: DisconnectedConnection) {
	return Do<void, ApiError>(async ($) => {
		$(await removeItem($(requirePlaidClient()), $(readPlaidCredential(connection.credential)).accessToken));
	});
}

/** Before one connection is deleted; `going` for one deleted along with others (`beforeDisconnectAll`). */
export async function beforeDisconnect(connection: DisconnectedConnection, going: string[] = [connection.id]): Promise<void> {
	if (connection.integrationId !== 'google' && connection.integrationId !== 'plaid') {
		return;
	}

	const undone = connection.integrationId === 'google' ? await revokeGoogle(connection, going) : await removePlaidItem(connection);
	if (undone.isErr()) {
		const error = undone.error;
		log.warn('Undoing a connection at its provider failed', {
			connectionId: connection.id,
			integrationId: connection.integrationId,
			kind: error.kind,
			...('cause' in error ? serializeError(error.cause) : {}),
		});
	}
}

/**
 * Before connections are deleted together, as an organization's or an account's are: each is undone
 * as if the others were gone already, so a Google account connected twice among them is revoked,
 * once, rather than kept for the other.
 */
export async function beforeDisconnectAll(connections: DisconnectedConnection[]): Promise<void> {
	const going = connections.map((connection) => connection.id);
	const revoked = new Set<string>();
	for (const connection of connections) {
		if (connection.integrationId === 'google') {
			if (revoked.has(connection.account)) {
				continue;
			}
			revoked.add(connection.account);
		}
		await beforeDisconnect(connection, going);
	}
}
