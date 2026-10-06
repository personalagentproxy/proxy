import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential} from '@proxy/db/connection';
import {findCollection, findIntegration} from '@proxy/integrations';

import type {Connector, RecordTarget} from './connector';
import {connectorFor} from './connectors';

/** The connection and collection a URL names in the organization, and the connector that reads them. */
export function loadRecordTarget(orgId: string, connectionId: string, collectionId: string): Promise<Result<RecordTarget & {connector: Connector}, ApiError>> {
	return Do(async ($) => {
		const connection = $(requirePresent($(await getConnectionWithCredential(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		const integration = findIntegration(connection.integrationId);
		const collection = integration && findCollection(integration, collectionId);
		const connector = connectorFor(connection.integrationId);
		if (!collection || !connector) {
			return $(Err(ApiErr.notFound('collection', collectionId)));
		}
		return {connection, collection, connector};
	});
}
