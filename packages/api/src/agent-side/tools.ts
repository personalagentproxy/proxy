import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getAgent, type AgentRow, type SignedInAgent} from '@proxy/db/agent';
import {logAgentRequest} from '@proxy/db/audit';
import {listConnections, type ConnectionRow} from '@proxy/db/connection';
import {allowedTools, applies, effectiveActions, findCollection, findIntegration, findTool, type Collection, type Condition, type OwnSettings, type Tool} from '@proxy/integrations';

import type {Connector, DataRecord, RecordPage, RecordTarget, RecordValues} from '../records/connector';
import {parseRecordValues} from '../records/record-values';
import {loadConnection} from '../records/target';
import {parseToolParams} from './tool-params';

/**
 * The agent side, whichever way an agent comes in: the connections it can use, the tools it has
 * with each, and running one. Every run is checked against the agent's access as it is now and
 * logged, a refused one too; one that can't be logged fails rather than go unrecorded.
 */

export type AgentConnection = {
	id: string;
	integrationId: string;
	account: string;
	// The actions the agent can take with the connection.
	actions: string[];
};

/** A page of records from a list, or the record a tool opened, wrote or ran on: null once it is gone. */
export type ToolResult = RecordPage | {record: DataRecord | null};

export function actionsOf(agent: AgentRow, connection: ConnectionRow): string[] {
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

export function requireAgent(signedIn: SignedInAgent): Promise<Result<AgentRow, ApiError>> {
	return Do(async ($) => {
		const agent = $(await getAgent(signedIn.orgId, signedIn.agentId));
		return $(requirePresent(agent, ApiErr.unauthenticated()));
	});
}

/** Who the agent is and what it can do with each connection; connections it can't use are left out. */
export function listAgentConnections(signedIn: SignedInAgent): Promise<Result<{agent: {id: string; providerId: string; name: string}; connections: AgentConnection[]}, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(signedIn));
		const connections = $(await listConnections(signedIn.orgId))
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

/** The tools the agent has with one connection: none for one it can't use. */
export function listAgentTools(signedIn: SignedInAgent, connectionId: string): Promise<Result<Tool[], ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(signedIn));
		const {connection, integration} = $(await loadConnection(signedIn.orgId, connectionId));
		return allowedTools(integration, actionsOf(agent, connection));
	});
}

type ToolRun = {signedIn: SignedInAgent; target: RecordTarget; connector: Connector; tool: Tool};

function recordTitle(collection: Collection, values: RecordValues): string | null {
	return values[collection.titleField]?.trim() || null;
}

// `query` is what a list searched for.
function log(run: ToolRun, outcome: 'allowed' | 'denied', title: string | null, query: string | null = null): Promise<Result<void, ApiError>> {
	return logAgentRequest({
		orgId: run.signedIn.orgId,
		agentId: run.signedIn.agentId,
		connectionId: run.target.connection.id,
		collectionId: run.target.collection.id,
		action: run.tool.operation,
		recordTitle: title,
		query,
		outcome,
	});
}

/**
 * Runs one of the connection's tools with `params`, as its input schema describes them. A
 * connection outside the organization, or a tool its integration doesn't have, is not found and
 * not logged; a tool whose action the agent doesn't have is refused and logged as denied.
 */
export function runAgentTool(signedIn: SignedInAgent, connectionId: string, toolName: string, params: unknown): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(signedIn));
		const {connection, integration, connector} = $(await loadConnection(signedIn.orgId, connectionId));
		const tool = $(requirePresent(findTool(integration, toolName), ApiErr.notFound('tool', toolName)));
		const collection = $(requirePresent(findCollection(integration, tool.collectionId), ApiErr.notFound('tool', toolName)));
		const run: ToolRun = {signedIn, target: {connection, collection}, connector, tool};

		// A list's search is logged, a refused one's too, so its params are read first.
		const listParams = tool.kind === 'list' ? $(parseToolParams(tool, params)) : null;
		if (!actionsOf(agent, connection).includes(tool.action)) {
			$(await log(run, 'denied', null, searchOf(listParams)));
			return $(Err(ApiErr.forbidden()));
		}
		return $(await execute(run, listParams ?? $(parseToolParams(tool, params))));
	});
}

function searchOf(params: Record<string, string> | null): string | null {
	return params?.search?.trim() || null;
}

function execute(run: ToolRun, params: Record<string, string>): Promise<Result<ToolResult, ApiError>> {
	const {kind} = run.tool;
	if (kind === 'list') {
		return list(run, params);
	}
	if (kind === 'get') {
		return get(run, params.id ?? '');
	}
	if (kind === 'create') {
		return create(run, params);
	}
	if (kind === 'update') {
		return update(run, params);
	}
	if (kind === 'delete') {
		return remove(run, params.id ?? '');
	}
	if (kind === 'command') {
		return command(run, params.id ?? '');
	}
	return newCommand(run, params);
}

// The params a write sets, without the record's id.
function fieldsOf(params: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'id'));
}

// A write or a command on a record it doesn't apply to, such as sending an email that isn't a
// draft, is a bad request rather than a matter of access, so it isn't logged.
function requireApplies(condition: Condition | undefined, record: DataRecord): Result<void, ApiError> {
	if (applies(condition, record.values)) {
		return Ok(undefined);
	}
	return Err(ApiErr.validationError(`Only for ${condition?.values.join(' or ')}`));
}

function list(run: ToolRun, params: Record<string, string>): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const {filterField} = run.target.collection;
		const query = {search: searchOf(params), page: params.page ?? null, filter: filterField ? (params[filterField] ?? null) : null};
		const page = $(await run.connector.list(run.target, query));
		$(await log(run, 'allowed', null, query.search));
		return page;
	});
}

function get(run: ToolRun, recordId: string): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const record = $(await run.connector.get(run.target, recordId));
		$(await log(run, 'allowed', recordTitle(run.target.collection, record.values)));
		return {record};
	});
}

function create(run: ToolRun, params: Record<string, string>): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const record = $(await run.connector.create(run.target, $(parseRecordValues(run.target.collection, params))));
		$(await log(run, 'allowed', recordTitle(run.target.collection, record.values)));
		return {record};
	});
}

// Only the fields given change: the rest are the record's as it is.
function update(run: ToolRun, params: Record<string, string>): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const {collection} = run.target;
		const recordId = params.id ?? '';
		const before = $(await run.connector.get(run.target, recordId));
		$(requireApplies(run.tool.where, before));
		const current = Object.fromEntries(collection.fields.filter((field) => !field.system).map((field) => [field.key, before.values[field.key] ?? '']));
		const values = $(parseRecordValues(collection, {...current, ...fieldsOf(params)}));
		const record = $(await run.connector.update(run.target, recordId, values));
		$(await log(run, 'allowed', recordTitle(collection, record.values)));
		return {record};
	});
}

function remove(run: ToolRun, recordId: string): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const before = $(await run.connector.get(run.target, recordId));
		$(requireApplies(run.tool.where, before));
		$(await run.connector.remove(run.target, recordId));
		$(await log(run, 'allowed', recordTitle(run.target.collection, before.values)));
		return {record: null};
	});
}

function command(run: ToolRun, recordId: string): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const runner = $(requirePresent(run.connector.commands?.[run.tool.operation], ApiErr.notFound('tool', run.tool.name)));
		const before = $(await run.connector.get(run.target, recordId));
		$(requireApplies(run.tool.where, before));
		const record = $(await runner(run.target, recordId));
		$(await log(run, 'allowed', recordTitle(run.target.collection, before.values)));
		return {record};
	});
}

function newCommand(run: ToolRun, params: Record<string, string>): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const runner = $(requirePresent(run.connector.newCommands?.[run.tool.operation], ApiErr.notFound('tool', run.tool.name)));
		const values = $(parseRecordValues(run.target.collection, params));
		const record = $(await runner(run.target, values));
		$(await log(run, 'allowed', recordTitle(run.target.collection, values)));
		return {record};
	});
}
