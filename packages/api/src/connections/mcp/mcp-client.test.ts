import {afterAll, beforeEach, describe, expect, spyOn, test} from 'bun:test';

import {ApiErr} from '@proxy/utils';

import {callMcpTool, listMcpTools} from './mcp-client';
import type {McpServer} from './mcp-oauth';

const SERVER: McpServer = {
	name: 'Example',
	url: 'https://mcp.example.com/mcp',
	registerUrl: 'https://mcp.example.com/register',
	authorizeUrl: 'https://mcp.example.com/authorize',
	tokenUrl: 'https://mcp.example.com/token',
	scope: 'default',
};

const server = {requests: [] as Array<{url: string; headers: Headers; body: string; method?: string}>, answer: (): Response => Response.json({})};

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	server.requests.push({url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : ''});
	return server.answer();
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	server.requests = [];
});

describe('callMcpTool', () => {
	test('sends one tools/call with the token, no session, and reads a JSON answer', async () => {
		server.answer = () => Response.json({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: '<meetings_data count="0"></meetings_data>'}]}});
		const text = (await callMcpTool(SERVER, 'access-1', 'list_meetings', {time_range: 'last_30_days'})).unwrap();

		expect(text).toBe('<meetings_data count="0"></meetings_data>');
		expect(server.requests[0]?.url).toBe('https://mcp.example.com/mcp');
		expect(server.requests[0]?.headers.get('authorization')).toBe('Bearer access-1');
		expect(server.requests[0]?.headers.has('mcp-session-id')).toBe(false);
		expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'list_meetings', arguments: {time_range: 'last_30_days'}}});
	});

	test('reads an answer sent as an event stream', async () => {
		server.answer = () =>
			new Response(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: 'hello'}]}})}\n\n`, {headers: {'content-type': 'text/event-stream'}});

		expect((await callMcpTool(SERVER, 'access-1', 'get_account_info', {})).unwrap()).toBe('hello');
	});

	test('a token the server turns down is rejected credentials; a failed tool is the server out of reach', async () => {
		server.answer = () => new Response('Unauthorized', {status: 401});
		expect((await callMcpTool(SERVER, 'expired', 'list_meetings', {})).unwrapErr().kind).toBe('credentials_rejected');

		server.answer = () => Response.json({jsonrpc: '2.0', id: 1, result: {isError: true, content: [{type: 'text', text: 'Rate limit exceeded'}]}});
		expect((await callMcpTool(SERVER, 'access-1', 'list_meetings', {})).unwrapErr().kind).toBe('provider_unreachable');
	});

	test("a failed tool is what the server's toolError makes of it, where it knows", async () => {
		const server = {...SERVER, toolError: (text: string) => (text.includes('not_found') ? ApiErr.notFound('record') : null)};
		fetchSpy.mockImplementation((async (_input: string | URL | Request) =>
			Response.json({jsonrpc: '2.0', id: 1, result: {isError: true, content: [{type: 'text', text: 'object_not_found'}]}})) as typeof fetch);
		expect((await callMcpTool(server, 'access-1', 'fetch', {})).unwrapErr().kind).toBe('not_found');

		fetchSpy.mockImplementation((async (_input: string | URL | Request) =>
			Response.json({jsonrpc: '2.0', id: 1, result: {isError: true, content: [{type: 'text', text: 'rate_limited'}]}})) as typeof fetch);
		expect((await callMcpTool(server, 'access-1', 'fetch', {})).unwrapErr().kind).toBe('provider_unreachable');
	});
});

// A server that keeps a session, as any custom one may: initialized first, the call sent with its
// session, and the session ended after.
describe('a server with a handshake', () => {
	const stateful: McpServer = {...SERVER, handshake: true};

	function statefulServer(answer: (message: {id?: number; method?: string; params?: Record<string, unknown>}) => Response): void {
		fetchSpy.mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			const body = typeof init?.body === 'string' ? init.body : '';
			server.requests.push({url: String(input), headers: new Headers(init?.headers), body, method: init?.method ?? 'GET'} as (typeof server.requests)[number]);
			if (init?.method === 'DELETE') {
				return new Response(null, {status: 200});
			}
			const message = JSON.parse(body) as {id?: number; method?: string; params?: Record<string, unknown>};
			if (message.method === 'initialize') {
				return Response.json(
					{jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2025-03-26', capabilities: {}, serverInfo: {name: 'x', version: '1'}}},
					{headers: {'mcp-session-id': 'session-1'}},
				);
			}
			if (message.method === 'notifications/initialized') {
				return new Response(null, {status: 202});
			}
			return answer(message);
		}) as typeof fetch);
	}

	test('initializes, tells the server it is ready, calls with the session and the version the server chose, and ends it', async () => {
		statefulServer((message) => Response.json({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: 'hello'}]}}));
		expect((await callMcpTool(stateful, null, 'greet', {name: 'Alex'})).unwrap()).toBe('hello');

		const methods = server.requests.map((request) => (request.body ? (JSON.parse(request.body) as {method?: string}).method : 'DELETE'));
		expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
		expect(server.requests[0]?.headers.has('authorization')).toBe(false);
		expect(server.requests[0]?.headers.has('mcp-session-id')).toBe(false);
		expect(server.requests[2]?.headers.get('mcp-session-id')).toBe('session-1');
		expect(server.requests[2]?.headers.get('mcp-protocol-version')).toBe('2025-03-26');
		expect(server.requests[3]?.headers.get('mcp-session-id')).toBe('session-1');
	});

	test('lists every page of tools, leaving out what does not read as one', async () => {
		const search = {name: 'search', inputSchema: {type: 'object', properties: {q: {type: 'string'}}}, annotations: {readOnlyHint: true}};
		const publish = {name: 'publish', description: 'Publishes.', inputSchema: {type: 'object'}};
		statefulServer((message) => {
			const cursor = message.params?.cursor;
			const result = cursor === 'page-2' ? {tools: [publish, {inputSchema: {}}]} : {tools: [search], nextCursor: 'page-2'};
			return Response.json({jsonrpc: '2.0', id: message.id, result});
		});

		expect((await listMcpTools(stateful, 'access-1')).unwrap()).toEqual([search, publish]);
		expect(server.requests[2]?.headers.get('authorization')).toBe('Bearer access-1');
	});
});
