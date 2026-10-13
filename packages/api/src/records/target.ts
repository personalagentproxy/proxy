import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential} from '@proxy/db/connection';
import {findCollection, type Integration} from '@proxy/integrations';

import {integrationOf} from '../utils/connection-actions';
import type {Connector, RecordTarget} from './connector';
import {connectorFor} from './connectors';

// A custom MCP server has no connector: its tools are called as they are, not read as records.
export type LoadedConnection = {connection: RecordTarget['connection']; integration: Integration; connector: Connector | null};

/** A connection of the organization, with its integration and the connector that reads it. */
export function loadConnection(orgId: string, connectionId: string): Promise<Result<LoadedConnection, ApiError>> {
	return Do(async ($) => {
		const connection = $(requirePresent($(await getConnectionWithCredential(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		const integration = integrationOf(connection);
		if (!integration) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
		return {connection, integration, connector: connectorFor(connection.integrationId) ?? null};
	});
}

/** The connection and collection a URL names in the organization, and the connector that reads them. */
export function loadRecordTarget(orgId: string, connectionId: string, collectionId: string): Promise<Result<RecordTarget & {connector: Connector}, ApiError>> {
	return Do(async ($) => {
		const {connection, integration, connector} = $(await loadConnection(orgId, connectionId));
		const collection = findCollection(integration, collectionId);
		if (!collection || !connector) {
			return $(Err(ApiErr.notFound('collection', collectionId)));
		}
		return {connection, collection, connector};
	});
}
