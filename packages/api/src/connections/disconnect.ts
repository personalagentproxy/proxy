import {log, serializeError} from '../observability/log';
import type {DisconnectedConnection} from './integration';
import {apiIntegration} from './integrations';

/**
 * What is undone at the provider before a connection is deleted, where the provider has a way: its
 * module's `revoke`, as Google's grant is revoked and a Plaid bank login removed. A failure is
 * logged and the connection is deleted anyway; the person can still undo it at the provider.
 */

/** Before one connection is deleted; `going` for one deleted along with others (`beforeDisconnectAll`). */
export async function beforeDisconnect(connection: DisconnectedConnection, going: string[] = [connection.id]): Promise<void> {
	const revoke = apiIntegration(connection.integrationId)?.revoke;
	if (!revoke) {
		return;
	}

	const undone = await revoke.run(connection, going);
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
 * once, rather than kept for the other: what is undone for an account is undone once for it.
 */
export async function beforeDisconnectAll(connections: DisconnectedConnection[]): Promise<void> {
	const going = connections.map((connection) => connection.id);
	const undone = new Set<string>();
	for (const connection of connections) {
		const account = apiIntegration(connection.integrationId)?.revoke?.per === 'account' ? `${connection.integrationId}:${connection.account}` : null;
		if (account !== null && undone.has(account)) {
			continue;
		}
		if (account !== null) {
			undone.add(account);
		}
		await beforeDisconnect(connection, going);
	}
}
