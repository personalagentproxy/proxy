import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import type {SignedInAgent} from '@proxy/db/agent';
import {findCollection, integrationFor} from '@proxy/integrations';

import {listAgentConnections} from '../agent-side/tools';
import {isRecordStore} from '../records/connector';
import {connectorFor} from '../records/connectors';
import {connectionName} from './alerts';

/**
 * Which connections a watch may be set on, as the agent reaches them: checked when a watch is set
 * (tool-job.ts) and again before a match is told (watches.ts). On its own, since it reaches for
 * the connectors and the agent's connections, which the words of alerts (alerts.ts) needn't.
 */

/** A connection the agent may watch for a collection: by id, and as the person knows it. */
export type WatchableConnection = {id: string; name: string};

/**
 * The connections the agent may watch for the collection: those it reaches, acting as the member
 * whose conversation it is, whose connector polls the collection, and which it may read, since a
 * match tells the person what a record says. Checked when a watch is set, and again before a match
 * is told, so a read revoked since delivers nothing.
 */
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
			return [{id: connection.id, name: connectionName(connection)}];
		});
	});
}
