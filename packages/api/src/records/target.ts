import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {getConnectionWithCredential} from '@proxy/db/connection';
import type {Viewer} from '@proxy/db/viewer';
import {findCollection, type Integration} from '@proxy/integrations';

import {integrationOf} from '../utils/connection-actions';
import type {Connector, RecordTarget} from './connector';
import {connectorFor} from './connectors';

type LoadedConnection = {connection: RecordTarget['connection']; integration: Integration};

function loaded(connection: RecordTarget['connection'] | null, connectionId: string): Result<LoadedConnection, ApiError> {
	if (!connection) {
		return Err(ApiErr.notFound('connection', connectionId));
	}
	const integration = integrationOf(connection);
	if (!integration) {
		return Err(ApiErr.notFound('connection', connectionId));
	}
	return Ok({connection, integration});
}

/** A connection the viewer sees, with its integration. */
export function loadConnection(viewer: Viewer, connectionId: string): Promise<Result<LoadedConnection, ApiError>> {
	return Do(async ($) => {
		return $(loaded($(await getConnectionWithCredential(viewer, connectionId)), connectionId));
	});
}

/**
 * The connection and collection a URL names among those the viewer sees, and the collection's
 * connector. A custom MCP server's collections have none: its tools are called as they are, not
 * read as records.
 */
export function loadRecordTarget(viewer: Viewer, connectionId: string, collectionId: string): Promise<Result<RecordTarget & {connector: Connector}, ApiError>> {
	return Do(async ($) => {
		const {connection, integration} = $(await loadConnection(viewer, connectionId));
		const collection = findCollection(integration, collectionId);
		const connector = connectorFor(integration.id, collectionId);
		if (!collection || !connector) {
			return $(Err(ApiErr.notFound('collection', collectionId)));
		}
		return {connection, collection, connector};
	});
}
