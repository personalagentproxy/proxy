import {afterAll, beforeEach, describe, expect, spyOn, test} from 'bun:test';

import {ApiErr} from '@proxy/utils';

import {callMcpTool} from './mcp-client';
import type {McpServer} from './mcp-oauth';

const SERVER: McpServer = {
	name: 'Example',
	url: 'https://mcp.example.com/mcp',
	registerUrl: 'https://mcp.example.com/register',
	authorizeUrl: 'https://mcp.example.com/authorize',
	tokenUrl: 'https://mcp.example.com/token',
	scope: 'default',
};

const server = {requests: [] as Array<{url: string; headers: Headers; body: string}>, answer: (): Response => Response.json({})};

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
