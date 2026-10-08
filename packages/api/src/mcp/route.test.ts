import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const getAgentByAccessToken = mock();

mock.module('@proxy/db/oauth', () => ({getAgentByAccessToken}));

const listAgentConnections = mock();
const listAgentTools = mock();
const runAgentTool = mock();

mock.module('../agent-side/tools', () => ({listAgentConnections, listAgentTools, runAgentTool}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', providerId: 'claude', name: 'Claude'};
const mailbox = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', actions: ['read', 'archive']};

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
		end: mock(() => res),
	};
	return res;
}

async function post(body: unknown, headers: Record<string, string> = {authorization: 'Bearer token-1'}) {
	const {handleMcpRoute} = await import('./route');
	const res = makeRes();
	await handleMcpRoute({body, headers} as never, res as never);
	return res;
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
	return {jsonrpc: '2.0', id, method, params};
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgentByAccessToken.mockResolvedValue(Ok(signedIn));
	listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'}, connections: [mailbox]}));
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
		expect(result.capabilities).toEqual({tools: {listChanged: false}});
		expect(result.instructions).toStartWith('You are signed in to Personal Agent Proxy as Claude.');
		expect(result.instructions).toContain('Start with list_connections');
		expect(result.instructions).toContain('- Email (alex@example.com), connection mail-1: Read, Archive');
	});

	test('lists the four tools, read-only ones marked so', async () => {
		const res = await post(rpc('tools/list'));
		const tools = (res.body as {result: {tools: Array<{name: string; annotations: {readOnlyHint: boolean}}>}}).result.tools;

		expect(tools.map((tool) => [tool.name, tool.annotations.readOnlyHint])).toEqual([
			['list_connections', true],
			['list_tools', true],
			['read', true],
			['run', false],
		]);
	});

	test('list_connections says what the agent can do with each', async () => {
		const res = await post(rpc('tools/call', {name: 'list_connections', arguments: {}}));

		expect((res.body as {result: unknown}).result).toMatchObject({
			structuredContent: {connections: [{connection: 'mail-1', integration: 'Email', account: 'alex@example.com', can: 'Read, Archive'}]},
		});
	});

	test('read and run go to the agent side over MCP, read only for tools that read', async () => {
		runAgentTool.mockResolvedValue(Ok({record: null}));
		await post(rpc('tools/call', {name: 'read', arguments: {connection: 'mail-1', tool: 'emails_list', params: {folder: 'Inbox'}}}));
		await post(rpc('tools/call', {name: 'run', arguments: {connection: 'mail-1', tool: 'emails_archive', params: {id: 'inbox-1'}}}));

		expect(runAgentTool.mock.calls).toEqual([
			[{agent: signedIn, via: 'mcp'}, 'mail-1', 'emails_list', {folder: 'Inbox'}, {readOnly: true}],
			[{agent: signedIn, via: 'mcp'}, 'mail-1', 'emails_archive', {id: 'inbox-1'}, {readOnly: false}],
		]);
	});

	test('a refused call is a tool error in words a model can act on', async () => {
		runAgentTool.mockResolvedValue(Err(ApiErr.forbidden()));
		const forbidden = await post(rpc('tools/call', {name: 'run', arguments: {connection: 'mail-1', tool: 'emails_send', params: {id: 'drafts-1'}}}));
		runAgentTool.mockResolvedValue(Err(ApiErr.notFound('connection', 'nope')));
		const missing = await post(rpc('tools/call', {name: 'read', arguments: {connection: 'nope', tool: 'emails_list'}}));

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

	test('an MCP-Protocol-Version it does not know is refused', async () => {
		const res = await post(rpc('ping'), {authorization: 'Bearer token-1', 'mcp-protocol-version': '1999-01-01'});

		expect(res.statusCode).toBe(400);
	});
});
