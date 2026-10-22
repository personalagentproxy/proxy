import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const createConnection = mock();
const renewConnection = mock();

mock.module('@proxy/db/connection', () => ({
	getConnectionWithCredential: mock(),
	findAccountConnection,
	createConnection,
	renewConnection,
	updateConnectionCredential: mock(),
	getConnectionCredential: mock(async () => Ok(null)),
	updateConnectionTools: mock(),
	updateConnectionName: mock(),
}));

mock.module('@proxy/db/organization', () => ({getMembership: mock(async () => Ok({role: 'owner'})), listMemberNames: mock(async () => Ok([]))}));

const requireViewer = mock(async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}));

mock.module('../../utils/user-org', () => ({requireViewer, requireOwner: requireViewer}));

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

// The servers are on the internet.
mock.module('node:dns/promises', () => ({default: {lookup: async () => [{address: '93.184.216.34', family: 4}]}}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const CALLBACK = 'https://app.example.com/api/connections/notion/callback';

// Notion's authorization and MCP server: each request, and its answers.
const SELF = {workspace: {id: 'ws-1', name: 'Acme'}, user: {type: 'person', id: 'user-1', name: 'Alex', email: 'Alex@Example.com'}};

const notion = {requests: [] as Array<{url: URL; headers: Headers; body: string}>, self: SELF as object};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	notion.requests.push({url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : ''});
	if (url.pathname === '/register') {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	if (url.pathname === '/token') {
		// Refreshed tokens come without the workspace: only `notion-get-self` names it.
		return Response.json({access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'bearer', scope: '', resource: 'https://mcp.notion.com/mcp'});
	}
	return Response.json({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: JSON.stringify(notion.self)}]}});
}) as typeof fetch);

// The sign-in routes the api makes of Notion's declaration.
async function routes() {
	const {mcpConnectRoutes} = await import('../mcp/mcp-connect');
	const {NOTION_MCP} = await import('./route');
	return mcpConnectRoutes(NOTION_MCP);
}

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
	const {handleStart: handleStartNotionRoute} = await routes();
	const res = makeRes();
	await handleStartNotionRoute({user, params: {org: 'org-1'}, query: {}, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.notion-state');
	const authorizeUrl = new URL(res.redirect.mock.calls[0]?.[0] as string);
	return {cookie, authorizeUrl, state: authorizeUrl.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const {handleCallback: handleNotionCallbackRoute} = await routes();
	const res = makeRes();
	await handleNotionCallbackRoute({user, params: {org: 'org-1'}, query: args.query, headers: {cookie: `proxy.notion-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	notion.requests = [];
	notion.self = SELF;
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockResolvedValue(Ok({id: 'conn-1'}));
	renewConnection.mockResolvedValue(Ok(undefined));
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
		expect(JSON.parse(toolCall?.body ?? '{}').params).toEqual({name: 'notion-get-self', arguments: {}});
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'notion', account: 'alex@example.com · Acme', defaults: ['read']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toMatchObject({clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-1?added');
	});

	test('a sign-in Notion names no workspace for is named by who signed in alone', async () => {
		notion.self = {user: {type: 'person', id: 'user-1', name: 'Alex', email: 'Alex@Example.com'}};
		const {cookie, state} = await start();
		await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection.mock.calls[0]?.[0]).toMatchObject({integrationId: 'notion', account: 'alex@example.com'});
	});

	test('a sign-in turned down at Notion goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/new?error=notion');
		expect(createConnection).not.toHaveBeenCalled();
	});
});
