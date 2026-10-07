import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getAgent, type AgentRow} from '@proxy/db/agent';
import {logAgentRequest} from '@proxy/db/audit';
import {listConnections, type ConnectionRow} from '@proxy/db/connection';
import {applies, effectiveActions, findIntegration, requiredAction, type Collection, type Condition, type OwnSettings} from '@proxy/integrations';

import type {Connector, DataRecord, RecordPage, RecordTarget} from '../records/connector';
import {parseListQuery, requireFilter} from '../records/list-query';
import {parseRecordValues} from '../records/record-values';
import {loadRecordTarget} from '../records/target';
import type {AgentRequest} from '../server/middleware/require-agent';

export type AgentConnectionResponse = {
	id: string;
	integrationId: string;
	account: string;
	// The actions the agent can take with the connection.
	actions: string[];
};

function actionsOf(agent: AgentRow, connection: ConnectionRow): string[] {
	const integration = findIntegration(connection.integrationId);
	if (!integration) {
		return [];
	}
	const own: OwnSettings = Object.fromEntries(agent.grants.filter((grant) => grant.connectionId === connection.id).map((grant) => [grant.actionId, grant.allowed]));
	return effectiveActions(
		integration,
		connection.defaults.map((stored) => stored.actionId),
		own,
	);
}

function requireSignedInAgent(request: AgentRequest): Promise<Result<AgentRow, ApiError>> {
	return Do(async ($) => {
		const agent = $(await getAgent(request.agent.orgId, request.agent.agentId));
		return $(requirePresent(agent, ApiErr.unauthenticated()));
	});
}

/** Who the agent is and what it can do with each connection; connections it can't use are left out. */
export function handleAgentMeRoute(request: AgentRequest): Promise<Result<{agent: {id: string; providerId: string | null; name: string}; connections: AgentConnectionResponse[]}, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireSignedInAgent(request));
		const connections = $(await listConnections(request.agent.orgId))
			.map((connection) => ({
				id: connection.id,
				integrationId: connection.integrationId,
				account: connection.account,
				actions: actionsOf(agent, connection),
			}))
			.filter(({actions}) => actions.length > 0);
		return {agent: {id: agent.id, providerId: agent.providerId, name: agent.name}, connections};
	});
}

type AgentTarget = RecordTarget & {connector: Connector; actions: string[]};

function recordTitle(collection: Collection, record: DataRecord): string | null {
	return record.values[collection.titleField]?.trim() || null;
}

// `action` is list, view, create, update or delete, or a command of the collection.
// `query` is what a list searched for.
function log(request: AgentRequest, target: RecordTarget, action: string, outcome: 'allowed' | 'denied', recordTitle: string | null, query: string | null = null): Promise<Result<void, ApiError>> {
	return logAgentRequest({
		orgId: request.agent.orgId,
		agentId: request.agent.agentId,
		connectionId: target.connection.id,
		collectionId: target.collection.id,
		action,
		recordTitle,
		query,
		outcome,
	});
}

const OPERATIONS = ['list', 'view', 'create', 'update', 'delete'];

/**
 * The collection the URL names, if the agent may do `action` in it. A collection outside the
 * organization, or a command it doesn't have, is not found and not logged; an action the agent
 * doesn't have, or a write the collection doesn't offer, is refused and logged as denied.
 */
function authorize(request: AgentRequest, action: string, query: string | null = null): Promise<Result<AgentTarget, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireSignedInAgent(request));
		const target = $(await loadRecordTarget(request.agent.orgId, request.params.connectionId ?? '', request.params.collectionId ?? ''));
		const actions = actionsOf(agent, target.connection);
		const needed = requiredAction(target.collection, action);
		if (needed === null && !OPERATIONS.includes(action)) {
			return $(Err(ApiErr.notFound('command', action)));
		}
		if (needed === null || !actions.includes(needed)) {
			$(await log(request, target, action, 'denied', null, query));
			return $(Err(ApiErr.forbidden()));
		}
		return {...target, actions};
	});
}

// Every allowed request is logged before its result goes back; a request that can't be logged
// fails rather than go unrecorded.

/** A page of the collection's records, matching `?search=` and `?filter=` when given; the search is logged. */
export function handleAgentListRecordsRoute(request: AgentRequest): Promise<Result<RecordPage & {actions: string[]}, ApiError>> {
	return Do(async ($) => {
		const query = $(parseListQuery(request.query));
		const target = $(await authorize(request, 'list', query.search));
		$(requireFilter(target.collection, query.filter));
		const page = $(await target.connector.list(target, query));
		$(await log(request, target, 'list', 'allowed', null, query.search));
		return {actions: target.actions, ...page};
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
		$(requireApplies(target.collection.editable, $(await target.connector.get(target, request.params.recordId ?? ''))));
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
		$(requireApplies(target.collection.editable, record));
		$(await target.connector.remove(target, recordId));
		$(await log(request, target, 'delete', 'allowed', recordTitle(target.collection, record)));
	});
}

// A write or a command on a record it doesn't apply to, such as sending an email that isn't a
// draft, is a bad request rather than a matter of access, so it isn't logged.
function requireApplies(condition: Condition | undefined, record: DataRecord): Result<void, ApiError> {
	if (applies(condition, record.values)) {
		return Ok(undefined);
	}
	return Err(ApiErr.validationError(`Only for ${condition?.values.join(' or ')}`));
}

function findCommand(collection: Collection, commandId: string, on: 'record' | 'new') {
	return collection.commands?.find((command) => command.id === commandId && command.on === on);
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
		const command = $(requirePresent(findCommand(target.collection, commandId, 'record'), ApiErr.notFound('command', commandId)));
		const run = $(requirePresent(target.connector.commands?.[commandId], ApiErr.notFound('command', commandId)));

		const recordId = request.params.recordId ?? '';
		const before = $(await target.connector.get(target, recordId));
		$(requireApplies(command.where, before));
		const record = $(await run(target, recordId));
		$(await log(request, target, commandId, 'allowed', recordTitle(target.collection, before)));
		return {record};
	});
}

/**
 * Runs one of the collection's commands on values typed in, such as sending a new email: the
 * record it made, or null. Logged with the title the values give it.
 */
export function handleAgentRunNewCommandRoute(request: AgentRequest): Promise<Result<{record: DataRecord | null}, ApiError>> {
	return Do(async ($) => {
		const commandId = request.params.commandId ?? '';
		const target = $(await authorize(request, commandId));
		$(requirePresent(findCommand(target.collection, commandId, 'new'), ApiErr.notFound('command', commandId)));
		const run = $(requirePresent(target.connector.newCommands?.[commandId], ApiErr.notFound('command', commandId)));

		const {values} = $(parseSchema(writeBodySchema, request.body));
		const parsed = $(parseRecordValues(target.collection, values));
		const record = $(await run(target, parsed));
		const title = parsed[target.collection.titleField]?.trim() || null;
		$(await log(request, target, commandId, 'allowed', title));
		return {record};
	});
}
