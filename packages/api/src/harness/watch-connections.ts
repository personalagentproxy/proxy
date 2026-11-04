import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import type {SignedInAgent} from '@proxy/db/agent';
import {findCollection, integrationFor} from '@proxy/integrations';

import {listAgentConnections} from '../agent-side/tools';
import {isRecordStore} from '../records/connector';
import {connectorFor} from '../records/connectors';

/**
 * The connections the agent may watch for a collection: those it reaches, acting as the member
 * whose conversation it is, whose integration polls the collection (its connector has `changes`),
 * and which the agent may read, since a match tells the person what a record says. Checked when a
 * watch is set, and again before a match is told, so a read revoked since never delivers.
 */
export type WatchableConnection = {id: string; name: string};

function called(connection: {name: string | null; integrationId: string; account: string}): string {
	return connection.name ?? `${integrationFor(connection)?.name ?? connection.integrationId} (${connection.account})`;
}

export function watchableConnections(signedIn: SignedInAgent, collectionId: string): Promise<Result<WatchableConnection[], ApiError>> {
	return Do(async ($) => {
		const {connections} = $(await listAgentConnections(signedIn));
		return connections.flatMap((connection) => {
			const integration = integrationFor(connection);
			const collection = integration ? findCollection(integration, collectionId) : undefined;
			const connector = connectorFor(connection.integrationId, collectionId);
			if (!collection?.read || !connection.actions.includes(collection.read) || !connector || !isRecordStore(connector) || !connector.changes) {
				return [];
			}
			return [{id: connection.id, name: called(connection)}];
		});
	});
}
