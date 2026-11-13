import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import type {SignedInAgent} from '@proxy/db/agent';
import {type Collection, findCollection, type Integration, integrationFor} from '@proxy/integrations';

import {listAgentConnections} from '../agent-side/tools';
import {type Changes, isRecordStore} from '../records/connector';
import {connectorFor} from '../records/connectors';
import {connectionName} from './alerts';

/**
 * Which connections a watch may be set on, as the agent reaches them: checked when a watch is set
 * (tool-job.ts) and again before a match is told (alert-sweep.ts). On its own, since it reaches for
 * the connectors and the agent's connections, which the words of alerts (alerts.ts) needn't.
 */

/**
 * The collection of a connection of the integration, and its connector's `changes`, where a watch
 * can be on it: what a poll's looks read (alert-sweep.ts).
 */
export function watchedCollection(integration: Integration | undefined, integrationId: string, collectionId: string): {collection: Collection; changes: Changes} | null {
	const collection = integration ? findCollection(integration, collectionId) : undefined;
	const connector = connectorFor(integrationId, collectionId);
	if (!collection || !connector || !isRecordStore(connector) || !connector.changes) {
		return null;
	}
	return {collection, changes: connector.changes};
}

/** A connection the agent may watch for a collection: by id, and as the person knows it. */
export type WatchableConnection = {id: string; name: string};

/**
 * The connections the agent may watch for the collection: those it reaches, acting as the member
 * whose chat it is, whose connector polls the collection, and which it may read, since a
 * match tells the person what a record says. Checked when a watch is set, and again before a match
 * is told, so a read revoked since delivers nothing.
 */
export function watchableConnections(signedIn: SignedInAgent, collectionId: string): Promise<Result<WatchableConnection[], ApiError>> {
	return Do(async ($) => {
		const {connections} = $(await listAgentConnections(signedIn));
		return connections.flatMap((connection) => {
			const read = watchedCollection(integrationFor(connection), connection.integrationId, collectionId)?.collection.read;
			if (!read || !connection.actions.includes(read)) {
				return [];
			}
			return [{id: connection.id, name: connectionName(connection)}];
		});
	});
}
