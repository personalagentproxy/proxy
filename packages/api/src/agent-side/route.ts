import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getAgent, type AgentRow} from '@proxy/db/agent';
import {logAgentRequest} from '@proxy/db/audit';
import {listConnections, type ConnectionRow} from '@proxy/db/connection';
import {effectiveActions, findIntegration, requiredAction, type Collection, type OwnSettings} from '@proxy/integrations';

import type {Connector, DataRecord, RecordTarget} from '../records/connector';
import {parseRecordValues} from '../records/record-values';
import {loadRecordTarget} from '../records/target';
import type {AgentRequest} from '../server/middleware/require-agent';

export type AgentConnectionResponse = {
	id: string;
	integrationId: string;
	account: string;
	// The actions the agent can take in each collection it can read.
	collections: Array<{id: string; actions: string[]}>;
};

function actionsOf(agent: AgentRow, connection: ConnectionRow, collection: Collection): string[] {
	const defaults = connection.defaults.filter((stored) => stored.collectionId === collection.id).map((stored) => stored.actionId);
	const own: OwnSettings = Object.fromEntries(
		agent.grants.filter((grant) => grant.connectionId === connection.id && grant.collectionId === collection.id).map((grant) => [grant.actionId, grant.allowed]),
	);
	return effectiveActions(collection, defaults, own);
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
					.map((collection) => ({id: collection.id, actions: actionsOf(agent, connection, collection)}))
					.filter(({actions}) => actions.length > 0),
			}))
			.filter(({collections}) => collections.length > 0);
		return {agent: {id: agent.id, name: agent.name}, connections};
	});
}

type AgentTarget = RecordTarget & {connector: Connector; actions: string[]};

function recordTitle(collection: Collection, record: DataRecord): string | null {
	return record.values[collection.titleField]?.trim() || null;
}

// `action` is list, view, create, update or delete, or a command of the collection.
function log(request: AgentRequest, target: RecordTarget, action: string, outcome: 'allowed' | 'denied', recordTitle: string | null): Promise<Result<void, ApiError>> {
	return logAgentRequest({
		orgId: request.agent.orgId,
		agentId: request.agent.agentId,
		connectionId: target.connection.id,
		collectionId: target.collection.id,
		action,
		recordTitle,
		outcome,
	});
}

const OPERATIONS = ['list', 'view', 'create', 'update', 'delete'];

/**
 * The collection the URL names, if the agent may do `action` in it. A collection outside the
 * organization, or a command it doesn't have, is not found and not logged; an action the agent
 * doesn't have, or a write the collection doesn't offer, is refused and logged as denied.
 */
function authorize(request: AgentRequest, action: string): Promise<Result<AgentTarget, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireSignedInAgent(request));
		const target = $(await loadRecordTarget(request.agent.orgId, request.params.connectionId ?? '', request.params.collectionId ?? ''));
		const actions = actionsOf(agent, target.connection, target.collection);
		const needed = requiredAction(target.collection, action);
		if (needed === null && !OPERATIONS.includes(action)) {
			return $(Err(ApiErr.notFound('command', action)));
		}
		if (needed === null || !actions.includes(needed)) {
			$(await log(request, target, action, 'denied', null));
			return $(Err(ApiErr.forbidden()));
		}
		return {...target, actions};
	});
}

// Every allowed request is logged before its result goes back; a request that can't be logged
// fails rather than go unrecorded.

export function handleAgentListRecordsRoute(request: AgentRequest): Promise<Result<{actions: string[]; records: DataRecord[]}, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'list'));
		const records = $(await target.connector.list(target));
		$(await log(request, target, 'list', 'allowed', null));
		return {actions: target.actions, records};
	});
}

export function handleAgentGetRecordRoute(request: AgentRequest): Promise<Result<{actions: string[]; record: DataRecord}, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'view'));
		const record = $(await target.connector.get(target, request.params.recordId ?? ''));
		$(await log(request, target, 'view', 'allowed', recordTitle(target.collection, record)));
		return {actions: target.actions, record};
	});
}

const writeBodySchema = z.object({values: z.unknown()});

export function handleAgentCreateRecordRoute(request: AgentRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'create'));
		const {values} = $(parseSchema(writeBodySchema, request.body));
		const record = $(await target.connector.create(target, $(parseRecordValues(target.collection, values))));
		$(await log(request, target, 'create', 'allowed', recordTitle(target.collection, record)));
		return record;
	});
}

export function handleAgentUpdateRecordRoute(request: AgentRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'update'));
		const {values} = $(parseSchema(writeBodySchema, request.body));
		const record = $(await target.connector.update(target, request.params.recordId ?? '', $(parseRecordValues(target.collection, values))));
		$(await log(request, target, 'update', 'allowed', recordTitle(target.collection, record)));
		return record;
	});
}

export function handleAgentDeleteRecordRoute(request: AgentRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const target = $(await authorize(request, 'delete'));
		const recordId = request.params.recordId ?? '';
		const record = $(await target.connector.get(target, recordId));
		$(await target.connector.remove(target, recordId));
		$(await log(request, target, 'delete', 'allowed', recordTitle(target.collection, record)));
	});
}

/**
 * Runs one of the collection's commands on a record, such as archiving an email or sending a
 * draft: the record as it is after, or null once it has left the collection. A command the
 * collection doesn't have is not found and not logged.
 */
export function handleAgentRunCommandRoute(request: AgentRequest): Promise<Result<{record: DataRecord | null}, ApiError>> {
	return Do(async ($) => {
		const commandId = request.params.commandId ?? '';
		const target = $(await authorize(request, commandId));
		const run = $(requirePresent(target.connector.commands?.[commandId], ApiErr.notFound('command', commandId)));

		const recordId = request.params.recordId ?? '';
		const before = $(await target.connector.get(target, recordId));
		const record = $(await run(target, recordId));
		$(await log(request, target, commandId, 'allowed', recordTitle(target.collection, before)));
		return {record};
	});
}
