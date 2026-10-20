import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const getConnectionWithCredential = mock();
const createConnection = mock();
const renewConnection = mock();

mock.module('@proxy/db/connection', () => ({
	findAccountConnection,
	getConnectionWithCredential,
	createConnection,
	renewConnection,
	updateConnectionCredential: mock(),
	getConnectionCredential: mock(async () => Ok(null)),
	updateConnectionTools: mock(),
	updateConnectionName: mock(),
}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

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

const CALLBACK = 'https://app.example.com/api/connections/cloudflare/callback';

// Cloudflare's authorization and MCP server: each request, and its answers.
const cloudflare = {requests: [] as Array<{url: URL; headers: Headers; body: string}>};

function toolAnswer(text: object): Response {
	return new Response(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: JSON.stringify(text)}]}})}\n\n`, {
		headers: {'content-type': 'text/event-stream'},
	});
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const body = typeof init?.body === 'string' ? init.body : '';
	cloudflare.requests.push({url, headers: new Headers(init?.headers), body});
	if (url.pathname === '/register') {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	if (url.pathname === '/token') {
		return Response.json({access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 86399, token_type: 'bearer'});
	}
	// The MCP server turns a bad key down at the door.
	if (new Headers(init?.headers).get('authorization') === 'Bearer bad-key') {
		return new Response('Unauthorized', {status: 401});
	}
	if (JSON.parse(body).method === 'tools/list') {
		return Response.json({
			jsonrpc: '2.0',
			id: 1,
			result: {
				tools: [
					{name: 'search', inputSchema: {type: 'object'}},
					{name: 'execute', inputSchema: {type: 'object'}},
				],
			},
		});
	}
	// An account's token is the account, by name; a sign-in or a user's token the person, by email.
	if (new Headers(init?.headers).get('authorization') === 'Bearer account-token') {
		return toolAnswer({id: 'account:acc-1', name: 'Acme'});
	}
	return toolAnswer({id: 'user:user-1', email: 'Alex@Example.com'});
}) as typeof fetch);

// The sign-in routes the api makes of Cloudflare's declaration.
async function routes() {
	const {mcpConnectRoutes} = await import('../mcp/mcp-connect');
	const {CLOUDFLARE_MCP} = await import('./route');
	return mcpConnectRoutes(CLOUDFLARE_MCP);
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

async function start(query: Record<string, string> = {}) {
	const {handleStart} = await routes();
	const res = makeRes();
	await handleStart({user, query, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.cloudflare-state');
	const authorizeUrl = new URL(res.redirect.mock.calls[0]?.[0] as string);
	return {cookie, authorizeUrl, state: authorizeUrl.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const {handleCallback} = await routes();
	const res = makeRes();
	await handleCallback({user, query: args.query, headers: {cookie: `proxy.cloudflare-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	cloudflare.requests = [];
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockResolvedValue(Ok({id: 'conn-1'}));
	renewConnection.mockResolvedValue(Ok(undefined));
});

describe('the sign-in', () => {
	test("registers with Cloudflare's MCP server and sends the browser to its sign-in with PKCE, asking to read and write zones and the developer platform", async () => {
		const {cookie, authorizeUrl} = await start();

		expect(cloudflare.requests[0]?.url.href).toBe('https://mcp.cloudflare.com/register');
		expect(JSON.parse(cloudflare.requests[0]?.body ?? '{}')).toMatchObject({redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none'});
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://mcp.cloudflare.com/authorize');
		expect(authorizeUrl.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['user:read', 'account:read', 'offline_access', 'zone.read', 'dns.write', 'workers-scripts.write']));
		expect(authorizeUrl.searchParams.get('resource')).toBe('https://mcp.cloudflare.com/mcp');
		expect(cookie?.options).toMatchObject({httpOnly: true, path: '/api/connections/cloudflare'});
	});

	test('makes the connection for who signed in, by their email, agents reading', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		const toolCalls = cloudflare.requests.filter((request) => request.url.pathname === '/mcp');
		expect(toolCalls.map((call) => JSON.parse(call.body).params)).toEqual([{name: 'whoami', arguments: {}}]);
		expect(toolCalls[0]?.headers.get('authorization')).toBe('Bearer access-1');
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'cloudflare', account: 'alex@example.com', defaults: ['read']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toMatchObject({clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-1?added');
	});
});

describe('keyConnectRoute', () => {
	async function connectWithKey(body: unknown) {
		const {keyConnectRoute} = await import('../mcp/mcp-connect');
		const {CLOUDFLARE_MCP} = await import('./route');
		return keyConnectRoute(CLOUDFLARE_MCP)({user, body} as never);
	}

	beforeEach(() => {
		createConnection.mockImplementation(async (data: {integrationId: string; account: string; defaults: string[]}) =>
			Ok({id: 'conn-1', integrationId: data.integrationId, account: data.account, createdAt: new Date(), tools: null, name: null, defaults: data.defaults.map((actionId) => ({actionId}))}),
		);
	});

	test("connects with an account's API token, checked by listing the tools with it: the connection for its account, by name", async () => {
		const connection = (await connectWithKey({key: 'account-token'})).unwrap();

		const calls = cloudflare.requests.filter((request) => request.url.pathname === '/mcp');
		expect(calls.map((call) => JSON.parse(call.body).method)).toEqual(['tools/list', 'tools/call']);
		expect(findAccountConnection).toHaveBeenCalledWith({orgId: 'org-1', integrationId: 'cloudflare', account: 'Acme', providerAccountId: null});
		expect(JSON.parse(String(createConnection.mock.calls[0]?.[0].credential).replace(/^enc:/, ''))).toEqual({auth: 'key', key: 'account-token'});
		expect(connection).toMatchObject({id: 'conn-1', account: 'Acme'});
	});

	test("a user's API token is the same account as their sign-in, renewing its connection", async () => {
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0'}));
		await connectWithKey({key: 'user-token'});

		expect(findAccountConnection).toHaveBeenCalledWith({orgId: 'org-1', integrationId: 'cloudflare', account: 'alex@example.com', providerAccountId: null});
		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0'});
	});

	test('a token Cloudflare turns down is refused, and nothing saved', async () => {
		expect((await connectWithKey({key: 'bad-key'})).unwrapErr().kind).toBe('credentials_rejected');
		expect(createConnection).not.toHaveBeenCalled();
	});
});
