import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential} from '@proxy/db/connection';
import {findCollection, findIntegration, type Integration} from '@proxy/integrations';

import type {Connector, RecordTarget} from './connector';
import {connectorFor} from './connectors';

export type LoadedConnection = {connection: RecordTarget['connection']; integration: Integration; connector: Connector};

/** A connection of the organization, with its integration and the connector that reads it. */
export function loadConnection(orgId: string, connectionId: string): Promise<Result<LoadedConnection, ApiError>> {
	return Do(async ($) => {
		const connection = $(requirePresent($(await getConnectionWithCredential(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		const integration = findIntegration(connection.integrationId);
		const connector = connectorFor(connection.integrationId);
		if (!integration || !connector) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
		return {connection, integration, connector};
	});
}

/** The connection and collection a URL names in the organization, and the connector that reads them. */
export function loadRecordTarget(orgId: string, connectionId: string, collectionId: string): Promise<Result<RecordTarget & {connector: Connector}, ApiError>> {
	return Do(async ($) => {
		const {connection, integration, connector} = $(await loadConnection(orgId, connectionId));
		const collection = findCollection(integration, collectionId);
		if (!collection) {
			return $(Err(ApiErr.notFound('collection', collectionId)));
		}
		return {connection, collection, connector};
	});
}
