import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getAgent, type AgentRow} from '@proxy/db/agent';
import {logAgentRequest} from '@proxy/db/audit';
import {listConnections, type ConnectionRow} from '@proxy/db/connection';
import {allowsWrite, effectiveAccess, findIntegration, minAccess, providerAccess, type Access, type Collection} from '@proxy/integrations';

import type {Connector, DataRecord, RecordPage, RecordTarget} from '../records/connector';
import {parseListQuery} from '../records/list-query';
import {parseRecordValues} from '../records/record-values';
import {loadRecordTarget} from '../records/target';
import type {AgentRequest} from '../server/middleware/require-agent';

type AuditAction = 'list' | 'view' | 'create' | 'update' | 'delete';

const NEEDS: Record<AuditAction, Access> = {list: 'read', view: 'read', create: 'write', update: 'write', delete: 'write'};

export type AgentConnectionResponse = {
	id: string;
	integrationId: string;
	account: string;
	collections: Array<{id: string; access: Access}>;
};

function accessOf(agent: AgentRow, connection: ConnectionRow, collection: Collection): Access {
	const own = agent.grants.find((grant) => grant.connectionId === connection.id && grant.collectionId === collection.id);
	const fallback = connection.defaults.find((stored) => stored.collectionId === collection.id);
	return effectiveAccess({provider: providerAccess(collection), connectionDefault: fallback?.access ?? 'none', agent: own?.access ?? null});
}

function requireSignedInAgent(request: AgentRequest): Promise<Result<AgentRow, ApiError>> {
	return Do(async ($) => {
		const agent = $(await getAgent(request.agent.orgId, request.agent.agentId));
		return $(requirePresent(agent, ApiErr.unauthenticated()));
	});
}

/** Who the agent is and everything it can reach; collections it can't are left out. */
export function handleAgentMeRoute(request: AgentRequest): Promise<Result<{agent: {id: string; name: string}; connections: AgentConnectionResponse[]}, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireSignedInAgent(request));
		const connections = $(await listConnections(request.agent.orgId))
			.map((connection) => ({
				id: connection.id,
				integrationId: connection.integrationId,
				account: connection.account,
				collections: (findIntegration(connection.integrationId)?.collections ?? [])
					.map((collection) => ({id: collection.id, access: accessOf(agent, connection, collection)}))
					.filter(({access}) => access !== 'none'),
			}))
			.filter(({collections}) => collections.length > 0);
		return {agent: {id: agent.id, name: agent.name}, connections};
	});
}

type AgentTarget = RecordTarget & {connector: Connector; access: Access};

function recordTitle(collection: Collection, record: DataRecord): string | null {
	return record.values[collection.titleField]?.trim() || null;
}

type LoggedRequest = {action: AuditAction; outcome: 'allowed' | 'denied'; recordTitle?: string | null; query?: string | null};

function log(request: AgentRequest, target: RecordTarget, entry: LoggedRequest): Promise<Result<void, ApiError>> {
	return logAgentRequest({
		orgId: request.agent.orgId,
		agentId: request.agent.agentId,
		connectionId: target.connection.id,
		collectionId: target.collection.id,
		action: entry.action,
		recordTitle: entry.recordTitle ?? null,
		query: entry.query ?? null,
		outcome: entry.outcome,
	});
}

/**
 * The collection the URL names, if the agent may do `action` in it. A collection outside the
 * organization is not found and not logged; one the agent can't reach, or a change the provider
 * doesn't take (editing a sent email), is refused and logged as denied.
 */
function authorize(request: AgentRequest, action: AuditAction, query: string | null = null): Promise<Result<AgentTarget, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireSignedInAgent(request));
		const target = $(await loadRecordTarget(request.agent.orgId, request.params.connectionId ?? '', request.params.collectionId ?? ''));
		const access = accessOf(agent, target.connection, target.collection);
		const takesChange = action === 'list' || action === 'view' || allowsWrite(target.collection, action);
		if (minAccess(access, NEEDS[action]) !== NEEDS[action] || !takesChange) {
			$(await log(request, target, {action, outcome: 'denied', query}));
			return $(Err(ApiErr.forbidden()));
		}
		return {...target, access};
	});
}

// Every allowed request is logged before its result goes back; a request that can't be logged
// fails rather than go unrecorded.

/** A page of the collection's records, matching `?search=` when there is one. */
export function handleAgentListRecordsRoute(request: AgentRequest): Promise<Result<RecordPage & {access: Access}, ApiError>> {
	return Do(async ($) => {
		const query = $(parseListQuery(request.query));
		const target = $(await authorize(request, 'list', query.search));
		const page = $(await target.connector.list(target, query));
		$(await log(request, target, {action: 'list', outcome: 'allowed', query: query.search}));
		return {access: target.access, ...page};
	});
}

export function handleAgentGetRecordRoute(request: AgentRequest): Promise<Result<{access: Access; record: DataRecord}, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'view'));
		const record = $(await target.connector.get(target, request.params.recordId ?? ''));
		$(await log(request, target, {action: 'view', outcome: 'allowed', recordTitle: recordTitle(target.collection, record)}));
		return {access: target.access, record};
	});
}

const writeBodySchema = z.object({values: z.unknown()});

export function handleAgentCreateRecordRoute(request: AgentRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'create'));
		const {values} = $(parseSchema(writeBodySchema, request.body));
		const record = $(await target.connector.create(target, $(parseRecordValues(target.collection, values))));
		$(await log(request, target, {action: 'create', outcome: 'allowed', recordTitle: recordTitle(target.collection, record)}));
		return record;
	});
}

export function handleAgentUpdateRecordRoute(request: AgentRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'update'));
		const {values} = $(parseSchema(writeBodySchema, request.body));
		const record = $(await target.connector.update(target, request.params.recordId ?? '', $(parseRecordValues(target.collection, values))));
		$(await log(request, target, {action: 'update', outcome: 'allowed', recordTitle: recordTitle(target.collection, record)}));
		return record;
	});
}

export function handleAgentDeleteRecordRoute(request: AgentRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'delete'));
		const recordId = request.params.recordId ?? '';
		const record = $(await target.connector.get(target, recordId));
		$(await target.connector.remove(target, recordId));
		$(await log(request, target, {action: 'delete', outcome: 'allowed', recordTitle: recordTitle(target.collection, record)}));
	});
}
