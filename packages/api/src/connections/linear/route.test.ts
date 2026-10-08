import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const listConnections = mock();
const createConnection = mock();
const updateConnectionCredential = mock();

mock.module('@proxy/db/connection', () => ({listConnections, createConnection, updateConnectionCredential}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const CALLBACK = 'https://app.example.com/api/connections/linear/callback';

// Linear's authorization and MCP server: each request, and its answers.
const linear = {requests: [] as Array<{url: URL; headers: Headers; body: string}>};

function toolAnswer(text: object): Response {
	return new Response(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: JSON.stringify(text)}]}})}\n\n`, {
		headers: {'content-type': 'text/event-stream'},
	});
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const body = typeof init?.body === 'string' ? init.body : '';
	linear.requests.push({url, headers: new Headers(init?.headers), body});
	if (url.pathname === '/register') {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	if (url.pathname === '/token') {
		return Response.json({access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 86399, token_type: 'bearer'});
	}
	if (JSON.parse(body).params?.name === 'get_workspace') {
		return toolAnswer({id: 'ws-1', name: 'Acme', url: 'https://linear.app/acme'});
	}
	return toolAnswer({id: 'user-1', name: 'Alex Kim', email: 'Alex@Example.com', displayName: 'alex'});
}) as typeof fetch);

function makeRes() {
	const cookies: Array<{name: string; value: string; options: Record<string, unknown>}> = [];
	const res = {
		cookies,
		redirect: mock(),
		cookie: mock((name: string, value: string, options: Record<string, unknown>) => {
			cookies.push({name, value, options});
		}),
		clearCookie: mock(),
		status: mock(() => res),
		json: mock(() => res),
	};
	return res;
}

const user = {userId: 'user-1', email: 'alex@example.com'};

async function start() {
	const {handleStartLinearRoute} = await import('./route');
	const res = makeRes();
	await handleStartLinearRoute({user, query: {}, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.linear-state');
	const authorizeUrl = new URL(res.redirect.mock.calls[0]?.[0] as string);
	return {cookie, authorizeUrl, state: authorizeUrl.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const {handleLinearCallbackRoute} = await import('./route');
	const res = makeRes();
	await handleLinearCallbackRoute({user, query: args.query, headers: {cookie: `proxy.linear-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	linear.requests = [];
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockResolvedValue(Ok({id: 'conn-1'}));
	updateConnectionCredential.mockResolvedValue(Ok(true));
});

describe('handleStartLinearRoute', () => {
	test("registers with Linear's MCP server and sends the browser to its sign-in with PKCE, to read and write", async () => {
		const {cookie, authorizeUrl} = await start();

		expect(linear.requests[0]?.url.href).toBe('https://mcp.linear.app/register');
		expect(JSON.parse(linear.requests[0]?.body ?? '{}')).toMatchObject({redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none'});
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://mcp.linear.app/authorize');
		expect(authorizeUrl.searchParams.get('client_id')).toBe('client-1');
		expect(authorizeUrl.searchParams.get('scope')).toBe('read write');
		expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizeUrl.searchParams.get('resource')).toBe('https://mcp.linear.app/mcp');
		expect(cookie?.options).toMatchObject({httpOnly: true, path: '/api/connections/linear'});
	});
});

describe('handleLinearCallbackRoute', () => {
	test('makes the connection for who signed in and their workspace, agents reading issues', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		const toolCalls = linear.requests.filter((request) => request.url.pathname === '/mcp');
		expect(toolCalls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer access-1', 'Bearer access-1']);
		expect(toolCalls.map((call) => JSON.parse(call.body).params)).toEqual([
			{name: 'get_user', arguments: {query: 'me'}},
			{name: 'get_workspace', arguments: {}},
		]);
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'linear', account: 'alex@example.com · Acme', defaults: ['read']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toMatchObject({clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-1?added');
	});

	test('signing in to the same workspace again gives its connection the new tokens', async () => {
		listConnections.mockResolvedValue(Ok([{id: 'conn-0', integrationId: 'linear', account: 'alex@example.com · Acme'}]));
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection).not.toHaveBeenCalled();
		expect(updateConnectionCredential.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-0?added');
	});

	test('a sign-in turned down at Linear goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/new?error=linear');
		expect(createConnection).not.toHaveBeenCalled();
	});
});
