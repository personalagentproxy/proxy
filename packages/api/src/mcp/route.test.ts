import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const getAgentByAccessToken = mock();

mock.module('@proxy/db/oauth', () => ({getAgentByAccessToken}));

const listAgentConnections = mock();
const listAgentTools = mock();
const runAgentTool = mock();

mock.module('../agent-side/tools', () => ({listAgentConnections, listAgentTools, runAgentTool}));

const sendAgentFeedback = mock();

mock.module('../agent-side/feedback', () => ({sendAgentFeedback}));

const startAgentTask = mock();
const finishAgentTask = mock();
const requireOpenTask = mock();

mock.module('../agent-side/tasks', () => ({startAgentTask, finishAgentTask, requireOpenTask, listAgentOpenTasks: mock()}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', providerId: 'claude', name: 'Claude', experiments: []};
const mailbox = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', actions: ['read', 'archive'], tools: null, name: null};
const task = {id: 'task-1', agentId: 'agent-1', title: 'Triage inbox', goal: 'Archive the newsletters', via: 'mcp', createdAt: new Date('2026-10-16T09:00:00Z'), finishedAt: null};
const started = {task: 'task-1', title: 'Triage inbox', goal: 'Archive the newsletters', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null};

function makeRes() {
	const res = {
		statusCode: 200,
		body: undefined as unknown,
		headers: {} as Record<string, string>,
		status: mock((code: number) => {
			res.statusCode = code;
			return res;
		}),
		setHeader: mock((name: string, value: string) => {
			res.headers[name.toLowerCase()] = value;
			return res;
		}),
		json: mock((body: unknown) => {
			res.body = body;
			return res;
		}),
		end: mock((body?: string) => {
			res.body = body;
			return res;
		}),
	};
	return res;
}

async function post(body: unknown, headers: Record<string, string> = {authorization: 'Bearer token-1'}) {
	const {handleMcpRoute} = await import('./route');
	const res = makeRes();
	await handleMcpRoute({body, headers} as never, res as never);
	return res;
}

// The headers of a client on a session `initialize` began, as every client is once on tasks.
async function onSession(): Promise<Record<string, string>> {
	const initialized = await post(rpc('initialize', {protocolVersion: '2025-11-25'}));
	return {authorization: 'Bearer token-1', 'mcp-session-id': initialized.headers['mcp-session-id'] ?? ''};
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
	return {jsonrpc: '2.0', id, method, params};
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgentByAccessToken.mockResolvedValue(Ok(signedIn));
	listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'}, connections: [mailbox]}));
	requireOpenTask.mockResolvedValue(Ok(task));
	startAgentTask.mockResolvedValue(Ok(started));
	finishAgentTask.mockResolvedValue(Ok({...started, finishedAt: '2026-10-16T09:30:00.000Z'}));
});

describe('handleMcpRoute', () => {
	test('without a working token, a 401 pointing at where to sign in', async () => {
		const missing = await post(rpc('ping'), {});
		getAgentByAccessToken.mockResolvedValue(Ok(null));
		const expired = await post(rpc('ping'));

		expect(missing.statusCode).toBe(401);
		expect(missing.headers['www-authenticate']).toBe('Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"');
		expect(expired.headers['www-authenticate']).toContain('error="invalid_token"');
	});

	test('initialize answers the version asked for when it knows it, else its newest, with instructions for the agent', async () => {
		const known = await post(rpc('initialize', {protocolVersion: '2025-06-18'}));
		const unknown = await post(rpc('initialize', {protocolVersion: '1999-01-01'}));
		const result = (known.body as {result: {protocolVersion: string; instructions: string; capabilities: unknown}}).result;

		expect(result.protocolVersion).toBe('2025-06-18');
		expect((unknown.body as {result: {protocolVersion: string}}).result.protocolVersion).toBe('2025-11-25');
		expect(result.capabilities).toEqual({tools: {listChanged: true}});
		expect(result.instructions).toStartWith('You are signed in to Personal Agent Proxy as Claude.');
		expect(result.instructions).toContain('Start with start_task');
		expect(result.instructions).toContain('Call finish_task when the task is done');
		expect(result.instructions).toContain('with the task it was made for');
		expect(result.instructions).toContain('- Email (alex@example.com), connection mail-1: Read, Archive');
		expect(result.instructions).toContain('check Personal Agent Proxy first');
		expect(result.instructions).toContain('Personal Agent Proxy connects Email, Google, Granola, Notion, Linear, Cloudflare, Exa, Parallel, Plaid, PostgreSQL, MySQL and any custom MCP server');
		expect(result.instructions).toContain('https://app.example.com/connections/new');
		expect(result.instructions).toContain('give them its url');
		expect(result.instructions).toContain('send_feedback');
	});

	test("the vault is the agent's memory, to search before asking and to save to where it may", async () => {
		const vault = {id: 'vault-1', integrationId: 'vault', account: 'Alex', actions: ['readEntries'], tools: null, name: null};
		const instructions = async () => ((await post(rpc('initialize', {protocolVersion: '2025-06-18'}))).body as {result: {instructions: string}}).result.instructions;

		expect(await instructions()).not.toContain('memory');

		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'}, connections: [vault, mailbox]}));
		const reading = await instructions();
		expect(reading).toContain('The vault, connection vault-1, is your memory of the person');
		expect(reading).toContain('search it with entries_list');
		expect(reading).toContain('suggest they add it to their vault');
		expect(reading).not.toContain('entries_create');

		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'}, connections: [{...vault, actions: ['readEntries', 'writeEntries']}]}));
		const saving = await instructions();
		expect(saving).toContain('save it there with entries_create');
		expect(saving).toContain('edit that entry rather than adding another');
	});

	test('lists the seven tools, read-only ones marked so, every call but starting, finishing and feedback taking the task', async () => {
		const res = await post(rpc('tools/list'));
		const tools = (res.body as {result: {tools: Array<{name: string; annotations: {readOnlyHint: boolean}; inputSchema: {required: string[]}}>}}).result.tools;

		expect(tools.map((tool) => [tool.name, tool.annotations.readOnlyHint, tool.inputSchema.required.includes('task')])).toEqual([
			['start_task', false, false],
			['list_connections', true, true],
			['list_tools', true, true],
			['read', true, true],
			['run', false, true],
			['finish_task', false, true],
			['send_feedback', false, false],
		]);
	});

	test('start_task and finish_task go to the agent side over MCP', async () => {
		const start = await post(rpc('tools/call', {name: 'start_task', arguments: {title: 'Triage inbox', goal: 'Archive the newsletters'}}));
		const finish = await post(rpc('tools/call', {name: 'finish_task', arguments: {task: 'task-1'}}));

		expect(startAgentTask).toHaveBeenCalledWith({agent: signedIn, via: 'mcp'}, {title: 'Triage inbox', goal: 'Archive the newsletters'});
		expect((start.body as {result: unknown}).result).toMatchObject({structuredContent: started});
		expect(finishAgentTask).toHaveBeenCalledWith({agent: signedIn, via: 'mcp'}, {task: 'task-1'});
		expect((finish.body as {result: unknown}).result).toMatchObject({structuredContent: {task: 'task-1', finishedAt: '2026-10-16T09:30:00.000Z'}});
	});

	test('send_feedback goes to the agent side over MCP, with or without a task', async () => {
		sendAgentFeedback.mockResolvedValue(Ok({sent: true}));
		const args = {message: 'emails_list ignored the folder', connection: 'mail-1', tool: 'emails_list'};
		const res = await post(rpc('tools/call', {name: 'send_feedback', arguments: args}));

		expect(sendAgentFeedback).toHaveBeenCalledWith({agent: signedIn, via: 'mcp'}, args);
		expect((res.body as {result: unknown}).result).toMatchObject({structuredContent: {sent: true}});
	});

	test('list_connections says what the agent can do with each, for an open task', async () => {
		const res = await post(rpc('tools/call', {name: 'list_connections', arguments: {task: 'task-1'}}));

		expect(requireOpenTask).toHaveBeenCalledWith(signedIn, 'task-1');
		expect((res.body as {result: unknown}).result).toMatchObject({
			structuredContent: {connections: [{connection: 'mail-1', integration: 'Email', account: 'alex@example.com', can: 'Read, Archive'}]},
		});
	});

	test('a call without a task is refused, saying to start one; one for a task that is not the agent’s or is finished, as the agent side says', async () => {
		const headers = await onSession();
		listAgentConnections.mockClear();
		const taskless = await post(rpc('tools/call', {name: 'list_connections', arguments: {}}), headers);
		requireOpenTask.mockResolvedValue(Err(ApiErr.notFound('task', 'task-9')));
		const unknown = await post(rpc('tools/call', {name: 'list_tools', arguments: {task: 'task-9', connection: 'mail-1'}}));
		requireOpenTask.mockResolvedValue(Err(ApiErr.conflict('Task task-1 (Triage inbox) is finished. Start a new task for what you are doing now, and give its id as task.')));
		const finished = await post(rpc('tools/call', {name: 'list_tools', arguments: {task: 'task-1', connection: 'mail-1'}}));

		expect((taskless.body as {result: unknown}).result).toEqual({
			content: [{type: 'text', text: 'Every call is made for a task. Call start_task first, with a title and the goal, and give the id it answers with as task.'}],
			isError: true,
		});
		expect((unknown.body as {result: unknown}).result).toEqual({content: [{type: 'text', text: expect.stringContaining('There is no task task-9 for this login. Call start_task')}], isError: true});
		expect((finished.body as {result: unknown}).result).toEqual({content: [{type: 'text', text: expect.stringContaining('Task task-1 (Triage inbox) is finished')}], isError: true});
		expect(listAgentConnections).not.toHaveBeenCalled();
	});

	test('read and run go to the agent side over MCP for the task, read only for tools that read', async () => {
		runAgentTool.mockResolvedValue(Ok({record: null}));
		await post(rpc('tools/call', {name: 'read', arguments: {task: 'task-1', connection: 'mail-1', tool: 'emails_list', params: {folder: 'Inbox'}}}));
		await post(rpc('tools/call', {name: 'run', arguments: {task: 'task-1', connection: 'mail-1', tool: 'emails_archive', params: {id: 'inbox-1'}}}));
		const taskless = await post(rpc('tools/call', {name: 'run', arguments: {connection: 'mail-1', tool: 'emails_archive', params: {id: 'inbox-1'}}}), await onSession());

		expect(runAgentTool.mock.calls).toEqual([
			[{agent: signedIn, via: 'mcp', taskId: 'task-1'}, 'mail-1', 'emails_list', {folder: 'Inbox'}, {readOnly: true}],
			[{agent: signedIn, via: 'mcp', taskId: 'task-1'}, 'mail-1', 'emails_archive', {id: 'inbox-1'}, {readOnly: false}],
		]);
		expect(JSON.stringify(taskless.body)).toContain('Call start_task first');
	});

	test('a refused call is a tool error in words a model can act on', async () => {
		runAgentTool.mockResolvedValue(Err(ApiErr.forbidden()));
		const forbidden = await post(rpc('tools/call', {name: 'run', arguments: {task: 'task-1', connection: 'mail-1', tool: 'emails_send', params: {id: 'drafts-1'}}}));
		runAgentTool.mockResolvedValue(Err(ApiErr.notFound('connection', 'nope')));
		const missing = await post(rpc('tools/call', {name: 'read', arguments: {task: 'task-1', connection: 'nope', tool: 'emails_list'}}));

		expect((forbidden.body as {result: unknown}).result).toEqual({
			content: [{type: 'text', text: expect.stringContaining('This login may not run emails_send')}],
			isError: true,
		});
		expect(JSON.stringify(missing.body)).toContain('Call list_connections');
	});

	test('an unknown tool or method is a JSON-RPC error; a notification gets no answer', async () => {
		const tool = await post(rpc('tools/call', {name: 'delete_everything', arguments: {}}));
		const method = await post(rpc('resources/list'));
		const notification = await post({jsonrpc: '2.0', method: 'notifications/initialized'});

		expect(tool.body).toMatchObject({error: {code: -32602}});
		expect(method.body).toMatchObject({error: {code: -32601}});
		expect(notification.statusCode).toBe(202);
	});

	test('a batch is answered as one, leaving out its notifications', async () => {
		const res = await post([{jsonrpc: '2.0', method: 'notifications/initialized'}, rpc('ping', {}, 7)]);

		expect(res.body).toEqual([{jsonrpc: '2.0', id: 7, result: {}}]);
	});

	test('a session from before the tool list changed is told so ahead of a tool call’s answer, as a stream', async () => {
		const initialized = await post(rpc('initialize', {protocolVersion: '2025-11-25'}));
		const current = initialized.headers['mcp-session-id'] ?? '';
		const call = rpc('tools/call', {name: 'finish_task', arguments: {task: 'task-1'}});
		const streams = {authorization: 'Bearer token-1', accept: 'application/json, text/event-stream'};

		const stale = await post(call, {...streams, 'mcp-session-id': 'session-1.0123456789abcdef'});
		const fresh = await post(call, {...streams, 'mcp-session-id': current});
		const jsonOnly = await post(call, {authorization: 'Bearer token-1', accept: 'application/json', 'mcp-session-id': 'session-1.0123456789abcdef'});
		const listing = await post(rpc('tools/list'), {...streams, 'mcp-session-id': 'session-1.0123456789abcdef'});

		expect(current).toMatch(/^[\w-]+\.[0-9a-f]{16}$/);
		expect(stale.headers['content-type']).toBe('text/event-stream');
		const events = String(stale.body)
			.split('\n\n')
			.filter(Boolean)
			.map((event) => JSON.parse(event.replace('event: message\ndata: ', '')));
		expect(events).toEqual([{jsonrpc: '2.0', method: 'notifications/tools/list_changed'}, expect.objectContaining({id: 1, result: expect.objectContaining({structuredContent: expect.anything()})})]);
		expect(fresh.body).toMatchObject({id: 1, result: {structuredContent: {task: 'task-1'}}});
		expect(jsonOnly.body).toMatchObject({id: 1, result: {structuredContent: {task: 'task-1'}}});
		expect(listing.body).toMatchObject({id: 1, result: {tools: expect.any(Array)}});
	});

	// PRE-TASK CLIENTS (pre-task-clients.ts)
	test('a call without a task from a session begun before tasks runs for none, told the tool list changed', async () => {
		runAgentTool.mockResolvedValue(Ok({record: null}));
		const streams = {authorization: 'Bearer token-1', accept: 'application/json, text/event-stream'};
		const listed = await post(rpc('tools/call', {name: 'list_connections', arguments: {}}), streams);
		const ran = await post(rpc('tools/call', {name: 'run', arguments: {connection: 'mail-1', tool: 'emails_archive', params: {id: 'inbox-1'}}}), {authorization: 'Bearer token-1'});
		const withTask = await post(rpc('tools/call', {name: 'list_connections', arguments: {task: 'task-1'}}), streams);

		expect(listed.headers['content-type']).toBe('text/event-stream');
		expect(String(listed.body)).toStartWith('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
		expect(String(listed.body)).toContain('"connection":"mail-1"');
		expect(runAgentTool).toHaveBeenCalledWith({agent: signedIn, via: 'mcp', taskId: null}, 'mail-1', 'emails_archive', {id: 'inbox-1'}, {readOnly: false});
		expect(ran.body).toMatchObject({result: {structuredContent: {record: null}}});
		expect(requireOpenTask.mock.calls).toEqual([[signedIn, 'task-1']]);
		expect(withTask.body).toMatchObject({result: {structuredContent: {connections: [{connection: 'mail-1'}]}}});
	});

	test('an MCP-Protocol-Version it does not know is refused', async () => {
		const res = await post(rpc('ping'), {authorization: 'Bearer token-1', 'mcp-protocol-version': '1999-01-01'});

		expect(res.statusCode).toBe(400);
	});
});
