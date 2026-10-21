import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {getConnectionWithCredential, getOrgConnectionWithCredential, type Viewer} from '@proxy/db/connection';
import {findCollection, type Integration} from '@proxy/integrations';

import {integrationOf} from '../utils/connection-actions';
import type {Connector, RecordTarget} from './connector';
import {connectorFor} from './connectors';

// A custom MCP server has no connector: its tools are called as they are, not read as records.
export type LoadedConnection = {connection: RecordTarget['connection']; integration: Integration; connector: Connector | null};

function loaded(connection: RecordTarget['connection'] | null, connectionId: string): Result<LoadedConnection, ApiError> {
	if (!connection) {
		return Err(ApiErr.notFound('connection', connectionId));
	}
	const integration = integrationOf(connection);
	if (!integration) {
		return Err(ApiErr.notFound('connection', connectionId));
	}
	return Ok({connection, integration, connector: connectorFor(connection.integrationId) ?? null});
}

/** A connection the viewer sees, with its integration and the connector that reads it. */
export function loadConnection(viewer: Viewer, connectionId: string): Promise<Result<LoadedConnection, ApiError>> {
	return Do(async ($) => {
		return $(loaded($(await getConnectionWithCredential(viewer, connectionId)), connectionId));
	});
}

/**
 * A connection an agent reaches: until agents are a member's own or shared, every connection in
 * the agent's organization.
 */
export function loadAgentConnection(agent: {orgId: string}, connectionId: string): Promise<Result<LoadedConnection, ApiError>> {
	return Do(async ($) => {
		return $(loaded($(await getOrgConnectionWithCredential(agent.orgId, connectionId)), connectionId));
	});
}

/** The connection and collection a URL names among those the viewer sees, and the connector that reads them. */
export function loadRecordTarget(viewer: Viewer, connectionId: string, collectionId: string): Promise<Result<RecordTarget & {connector: Connector}, ApiError>> {
	return Do(async ($) => {
		const {connection, integration, connector} = $(await loadConnection(viewer, connectionId));
		const collection = findCollection(integration, collectionId);
		if (!collection || !connector) {
			return $(Err(ApiErr.notFound('collection', collectionId)));
		}
		return {connection, collection, connector};
	});
}
