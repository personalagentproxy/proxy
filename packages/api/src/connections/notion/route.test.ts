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

const CALLBACK = 'https://app.example.com/api/connections/notion/callback';

// Notion's authorization and MCP server: each request, and its answers.
const notion = {requests: [] as Array<{url: URL; headers: Headers; body: string}>};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	notion.requests.push({url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : ''});
	if (url.pathname === '/register') {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	if (url.pathname === '/token') {
		return Response.json({access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 28800, workspace_name: 'Acme', workspace_id: 'ws-1', user_id: 'user-1'});
	}
	const users = {results: [{type: 'person', id: 'user-1', name: 'Alex', email: 'Alex@Example.com'}], has_more: false};
	return Response.json({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: JSON.stringify(users)}]}});
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
	const {handleStartNotionRoute} = await import('./route');
	const res = makeRes();
	await handleStartNotionRoute({user, query: {}, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.notion-state');
	const authorizeUrl = new URL(res.redirect.mock.calls[0]?.[0] as string);
	return {cookie, authorizeUrl, state: authorizeUrl.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const {handleNotionCallbackRoute} = await import('./route');
	const res = makeRes();
	await handleNotionCallbackRoute({user, query: args.query, headers: {cookie: `proxy.notion-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	notion.requests = [];
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockResolvedValue(Ok({id: 'conn-1'}));
	updateConnectionCredential.mockResolvedValue(Ok(true));
});

describe('handleStartNotionRoute', () => {
	test("registers with Notion's MCP server and sends the browser to its sign-in with PKCE", async () => {
		const {cookie, authorizeUrl} = await start();

		expect(notion.requests[0]?.url.href).toBe('https://mcp.notion.com/register');
		expect(JSON.parse(notion.requests[0]?.body ?? '{}')).toMatchObject({redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none'});
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://mcp.notion.com/authorize');
		expect(authorizeUrl.searchParams.get('client_id')).toBe('client-1');
		expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizeUrl.searchParams.get('resource')).toBe('https://mcp.notion.com/mcp');
		expect(cookie?.options).toMatchObject({httpOnly: true, path: '/api/connections/notion'});
	});
});

describe('handleNotionCallbackRoute', () => {
	test('makes the connection for who signed in and their workspace, agents reading pages', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		const toolCall = notion.requests.find((request) => request.url.pathname === '/mcp');
		expect(toolCall?.headers.get('authorization')).toBe('Bearer access-1');
		expect(JSON.parse(toolCall?.body ?? '{}').params).toEqual({name: 'notion-get-users', arguments: {user_id: 'self'}});
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'notion', account: 'alex@example.com · Acme', defaults: ['read']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toMatchObject({clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-1?added');
	});

	test('a sign-in turned down at Notion goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/new?error=notion');
		expect(createConnection).not.toHaveBeenCalled();
	});
});
