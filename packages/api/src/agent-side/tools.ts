import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getAgentById, type AgentRow, type SignedInAgent} from '@proxy/db/agent';
import {logAgentRequest} from '@proxy/db/audit';
import {listConnectionsWithCredential, type ConnectionRow, type Viewer} from '@proxy/db/connection';
import {
	allowedTools,
	applies,
	effectiveActions,
	findCollection,
	findTool,
	type Collection,
	type CollectionTool,
	type Integration,
	type Condition,
	type McpTool,
	type OwnSettings,
	type ServerTool,
	type Tool,
	TOOLS_COLLECTION_ID,
} from '@proxy/integrations';

import {callCustomTool} from '../connections/custom/custom-mcp';
import {needsSignIn, signInNeededError, unavailableActions, unavailableError} from '../connections/unavailable';
import type {Connector, DataRecord, RecordPage, RecordTarget, RecordValues} from '../records/connector';
import {parseRecordValues} from '../records/record-values';
import {loadConnection} from '../records/target';
import {integrationOf} from '../utils/connection-actions';
import {requireOpenTaskIfAny} from '../mcp/pre-task-clients';
import {isPlainObject, parseToolParams} from './tool-params';

/**
 * The agent side, whichever way an agent comes in: the connections it can use, the tools it has
 * with each, and running one. Every run is made for one of the agent's tasks (tasks.ts), checked
 * against the agent's access as it is now and logged with the task, a refused one too; one that
 * can't be logged fails rather than go unrecorded.
 */

export type AgentConnection = {
	id: string;
	integrationId: string;
	account: string;
	// The actions the agent can take with the connection.
	actions: string[];
	// A custom MCP server's tools the agent may run, as the server describes them; null for every
	// other integration.
	tools: McpTool[] | null;
	// What the person called the connection, where they named it.
	name: string | null;
};

/** A page of records from a list, the record a tool opened, wrote or ran on (null once it is gone), or what a custom server's tool answered. */
export type ToolResult = RecordPage | {record: DataRecord | null} | {text: string};

// How much of a custom tool's params the activity log keeps.
const MAX_LOGGED_PARAMS = 200;

/** What the agent can do with the connection, none of the `unavailable` actions its sign-in didn't cover among them. */
export function actionsOf(agent: AgentRow, connection: ConnectionRow, integration: Integration, unavailable: string[]): string[] {
	const own: OwnSettings = Object.fromEntries(agent.grants.filter((grant) => grant.connectionId === connection.id).map((grant) => [grant.actionId, grant.allowed]));
	return effectiveActions(
		integration,
		connection.defaults.map((stored) => stored.actionId),
		own,
		unavailable,
	);
}

/**
 * What an agent reaches, as a viewer of its organization's connections: the shared ones and, for a
 * member's own agent, that member's own.
 */
export function agentViewer(signedIn: SignedInAgent): Viewer {
	return {orgId: signedIn.orgId, userId: signedIn.ownerUserId};
}

export function requireAgent(signedIn: SignedInAgent): Promise<Result<AgentRow, ApiError>> {
	return Do(async ($) => {
		const agent = $(await getAgentById(signedIn.orgId, signedIn.agentId));
		return $(requirePresent(agent, ApiErr.unauthenticated()));
	});
}

/** Who the agent is and what it can do with each connection it reaches; connections it can't use are left out. */
export function listAgentConnections(signedIn: SignedInAgent): Promise<Result<{agent: {id: string; providerId: string; name: string}; connections: AgentConnection[]}, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(signedIn));
		const connections = $(await listConnectionsWithCredential(agentViewer(signedIn)))
			.flatMap((connection) => {
				const integration = integrationOf(connection);
				if (!integration) {
					return [];
				}
				const actions = actionsOf(agent, connection, integration, unavailableActions(connection));
				return [
					{
						id: connection.id,
						integrationId: connection.integrationId,
						account: connection.account,
						actions,
						tools: integration.mcpTools?.filter((tool) => actions.includes(tool.name)) ?? null,
						name: connection.name,
					},
				];
			})
			.filter(({actions}) => actions.length > 0);
		return {agent: {id: agent.id, providerId: agent.providerId, name: agent.name}, connections};
	});
}

/** The tools the agent has with one connection: none for one it can't use. */
export function listAgentTools(signedIn: SignedInAgent, connectionId: string): Promise<Result<Tool[], ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(signedIn));
		const {connection, integration} = $(await loadConnection(agentViewer(signedIn), connectionId));
		return allowedTools(integration, actionsOf(agent, connection, integration, unavailableActions(connection)));
	});
}

// Who calls and which way it came in: the web app's agent pages, or the MCP server.
export type AgentCaller = {agent: SignedInAgent; via: 'web' | 'mcp'};

/** Who runs a tool, and the task it is run for, by its id. */
// PRE-TASK CLIENTS: null for a pre-task client's call (mcp/pre-task-clients.ts).
export type TaskCaller = AgentCaller & {taskId: string | null};

// `actions` are what the agent can do with the connection, and `refuse` why it can't do another.
type ToolRun = {caller: TaskCaller; target: RecordTarget; connector: Connector; tool: CollectionTool; actions: string[]; refuse: (actionId: string) => ApiError};

function recordTitle(collection: Collection, values: RecordValues): string | null {
	return values[collection.titleField]?.trim() || null;
}

// `query` is what a list searched for.
function log(run: ToolRun, outcome: 'allowed' | 'denied', title: string | null, query: string | null = null): Promise<Result<void, ApiError>> {
	return logAgentRequest({
		orgId: run.caller.agent.orgId,
		agentId: run.caller.agent.agentId,
		connectionId: run.target.connection.id,
		collectionId: run.target.collection.id,
		action: run.tool.operation,
		recordTitle: title,
		query,
		outcome,
		via: run.caller.via,
		taskId: run.caller.taskId,
		ownerUserId: run.caller.agent.ownerUserId,
	});
}

/**
 * Runs one of the connection's tools with `params`, as its input schema describes them, for the
 * caller's task, which has to be one of the agent's and still under way; a run without one is
 * refused, unlogged. A connection the agent doesn't reach, or a tool its integration doesn't have,
 * is not found and not logged; a tool whose action the agent doesn't have is refused and logged as
 * denied, saying how to allow it where the connection's sign-in didn't cover the action.
 * `readOnly` limits the run to tools that only read, or only to those that change something, as
 * the MCP server's `read` and `run` do; any other is refused, unlogged.
 */
export function runAgentTool(caller: TaskCaller, connectionId: string, toolName: string, params: unknown, options: {readOnly?: boolean} = {}): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		// None of the three needs another's answer, so they are read at once; a refusal still comes in this order.
		const [agentRead, taskRead, connectionRead] = await Promise.all([
			requireAgent(caller.agent),
			requireOpenTaskIfAny(caller.agent, caller.taskId),
			loadConnection(agentViewer(caller.agent), connectionId),
		]);
		const agent = $(agentRead);
		$(taskRead);
		const {connection, integration, connector} = $(connectionRead);
		const tool = $(requirePresent(findTool(integration, toolName), ApiErr.notFound('tool', toolName)));
		if (options.readOnly !== undefined && options.readOnly !== tool.readOnly) {
			return $(Err(ApiErr.validationError(tool.readOnly ? `${tool.name} only reads: use read for it` : `${tool.name} changes something: use run for it`)));
		}
		if (tool.kind === 'call') {
			return $(await runServerTool(caller, agent, connection, integration, tool, params));
		}

		const collection = $(requirePresent(findCollection(integration, tool.collectionId), ApiErr.notFound('tool', toolName)));
		const unavailable = unavailableActions(connection);
		const run: ToolRun = {
			caller,
			target: {connection, collection},
			connector: $(requirePresent(connector, ApiErr.notFound('tool', toolName))),
			tool,
			actions: actionsOf(agent, connection, integration, unavailable),
			refuse: (actionId) => refusal(integration, agent, connection, unavailable, actionId),
		};

		// A list's search is logged, a refused one's too, so its params are read first.
		const listParams = tool.kind === 'list' ? $(parseToolParams(tool, params)) : null;
		if (!run.actions.includes(tool.action)) {
			$(await log(run, 'denied', null, searchOf(listParams)));
			return $(Err(run.refuse(tool.action)));
		}
		return $(await execute(run, listParams ?? $(parseToolParams(tool, params))));
	});
}

// Why an action is refused: the sign-in, naming the action it didn't cover, or the connection
// having none, where signing in would allow it as the agent's settings stand; else plainly
// forbidden.
function refusal(integration: Integration, agent: AgentRow, connection: ConnectionRow & {credential: string | null}, unavailable: string[], actionId: string): ApiError {
	if (!actionsOf(agent, connection, integration, []).includes(actionId)) {
		return ApiErr.forbidden();
	}
	if (needsSignIn(connection)) {
		return signInNeededError(integration);
	}
	const required = integration.actions.find((action) => action.id === actionId)?.requires;
	return unavailableError(integration, unavailable.includes(actionId) || required === undefined ? actionId : required);
}

function searchOf(params: Record<string, string> | null): string | null {
	return params?.search?.trim() || null;
}

// What the activity log keeps of a custom tool's params: the JSON, cut short.
function loggedParams(args: Record<string, unknown>): string | null {
	if (Object.keys(args).length === 0) {
		return null;
	}
	const json = JSON.stringify(args);
	if (json.length <= MAX_LOGGED_PARAMS) {
		return json;
	}
	return `${json.slice(0, MAX_LOGGED_PARAMS - 1)}…`;
}

// A custom server's tool, called as it is: its params go to the server as given, which checks
// them against its own schema, and its answer comes back as text. Logged by the tool's name, with
// its params, allowed or denied.
function runServerTool(
	caller: TaskCaller,
	agent: AgentRow,
	connection: ConnectionRow & {credential: string | null},
	integration: Integration,
	tool: ServerTool,
	params: unknown,
): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const args = params ?? {};
		if (!isPlainObject(args)) {
			return $(Err(ApiErr.validationError(`${tool.name} takes an object of params`)));
		}
		const logged = loggedParams(args);
		const logRun = (outcome: 'allowed' | 'denied') =>
			logAgentRequest({
				orgId: caller.agent.orgId,
				agentId: caller.agent.agentId,
				connectionId: connection.id,
				collectionId: TOOLS_COLLECTION_ID,
				action: tool.name,
				recordTitle: null,
				query: logged,
				outcome,
				via: caller.via,
				taskId: caller.taskId,
				ownerUserId: caller.agent.ownerUserId,
			});
		if (!actionsOf(agent, connection, integration, unavailableActions(connection)).includes(tool.action)) {
			$(await logRun('denied'));
			return $(Err(ApiErr.forbidden()));
		}
		const text = $(await callCustomTool(connection, tool.name, args));
		$(await logRun('allowed'));
		return {text};
	});
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

// The params a write sets, without the record's id or the one a new record goes in.
function fieldsOf(params: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'id' && key !== 'parent'));
}

// A write or a command on a record it doesn't apply to, such as sending an email that isn't a
// draft, is a bad request rather than a matter of access, so it isn't logged.
function requireApplies(condition: Condition | undefined, record: DataRecord): Result<void, ApiError> {
	if (applies(condition, record.values)) {
		return Ok(undefined);
	}
	return Err(ApiErr.validationError(`Only for ${condition?.values.join(' or ')}`));
}

// A list opened inside a record, in a nested collection, is logged with that record's title.
function list(run: ToolRun, params: Record<string, string>): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const {filterField} = run.target.collection;
		const query = {search: searchOf(params), page: params.page ?? null, filter: filterField ? (params[filterField] ?? null) : null, parent: params.parent ?? null};
		const page = $(await run.connector.list(run.target, query));
		$(await log(run, 'allowed', page.trail?.at(-1)?.title ?? null, query.search));
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

// A write needs the action of each field holding anything, before it or after it, beyond its own:
// inviting guests to an event, or changing one they are invited to, needs Invite guests. One
// without it is refused and logged as denied, with the record's title where there is one.
function requireFieldActions(run: ToolRun, values: RecordValues, before: RecordValues = {}): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const missing = run.target.collection.fields.find(
			(field) => field.action !== undefined && !run.actions.includes(field.action) && [values[field.key], before[field.key]].some((value) => (value ?? '').trim() !== ''),
		);
		if (missing?.action === undefined) {
			return;
		}
		$(await log(run, 'denied', recordTitle(run.target.collection, {...before, ...values})));
		return $(Err(run.refuse(missing.action)));
	});
}

function create(run: ToolRun, params: Record<string, string>): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const values = $(parseRecordValues(run.target.collection, fieldsOf(params)));
		$(await requireFieldActions(run, values));
		const record = $(await run.connector.create(run.target, values, params.parent ?? null));
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
		$(await requireFieldActions(run, values, before.values));
		const record = $(await run.connector.update(run.target, recordId, values, before));
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
