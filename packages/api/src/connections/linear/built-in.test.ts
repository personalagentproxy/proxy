import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const getConnectionWithCredential = mock();
const createConnection = mock();
const renewConnection = mock();
const shareConnection = mock();

mock.module('@proxy/db/connection', () => ({
	findAccountConnection,
	getConnectionWithCredential,
	createConnection,
	renewConnection,
	shareConnection,
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

// None of the integrations' modules is needed here: what they declare is the integrations' own.
mock.module('../integrations', () => ({apiIntegration: () => undefined, apiIntegrations: () => []}));

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
	// The MCP server turns a bad key down at the door.
	if (new Headers(init?.headers).get('authorization') === 'Bearer bad-key') {
		return new Response('Unauthorized', {status: 401});
	}
	if (JSON.parse(body).method === 'tools/list') {
		return Response.json({jsonrpc: '2.0', id: 1, result: {tools: [{name: 'list_issues', inputSchema: {type: 'object'}}]}});
	}
	if (JSON.parse(body).params?.name === 'get_workspace') {
		return toolAnswer({id: 'ws-1', name: 'Acme', url: 'https://linear.app/acme'});
	}
	return toolAnswer({id: 'user-1', name: 'Alex Kim', email: 'Alex@Example.com', displayName: 'alex'});
}) as typeof fetch);

// The sign-in routes the api makes of Linear's declaration.
async function routes() {
	const {mcpConnectRoutes} = await import('../mcp/mcp-connect');
	const {LINEAR_MCP} = await import('./built-in');
	return mcpConnectRoutes(LINEAR_MCP);
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
	const {handleStart: handleStartLinearRoute} = await routes();
	const res = makeRes();
	await handleStartLinearRoute({user, params: {org: 'org-1'}, query, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.linear-state');
	const authorizeUrl = new URL(res.redirect.mock.calls[0]?.[0] as string);
	return {cookie, authorizeUrl, state: authorizeUrl.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const {handleCallback: handleLinearCallbackRoute} = await routes();
	const res = makeRes();
	await handleLinearCallbackRoute({user, params: {org: 'org-1'}, query: args.query, headers: {cookie: `proxy.linear-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	linear.requests = [];
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockResolvedValue(Ok({id: 'conn-1'}));
	renewConnection.mockResolvedValue(Ok(undefined));
	shareConnection.mockResolvedValue(Ok(undefined));
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
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-1?added');
	});

	test('signing in to the same workspace again gives its connection the new tokens', async () => {
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0'}));
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-0');
	});

	test("signing in for everyone to a workspace that is the person's own shares its connection, never connecting it twice", async () => {
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0', ownerUserId: 'user-1'}));
		const {cookie, state} = await start({share: 'everyone'});
		await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0'});
		expect(shareConnection).toHaveBeenCalledWith('conn-0');
	});

	test('signing in again for oneself, or to a shared connection, shares nothing', async () => {
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0', ownerUserId: 'user-1'}));
		const own = await start();
		await callback({cookie: own.cookie?.value ?? '', query: {state: own.state, code: 'code-1'}});
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0', ownerUserId: null}));
		const shared = await start({share: 'everyone'});
		await callback({cookie: shared.cookie?.value ?? '', query: {state: shared.state, code: 'code-1'}});

		expect(renewConnection).toHaveBeenCalledTimes(2);
		expect(shareConnection).not.toHaveBeenCalled();
	});

	test('signing in from a connection never signed in to, as one moved over without a sign-in, gives that one the new tokens', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({id: 'conn-0', integrationId: 'linear', account: 'mcp.linear.app/mcp', credential: null}));
		const {cookie, state} = await start({connection: 'conn-0'});
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(getConnectionWithCredential).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-0');
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0', account: 'alex@example.com · Acme'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-0');
	});

	test('signing in from a connection never signed in to, as an account connected since, gives that account its connection the new tokens, never a second one', async () => {
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-5'}));
		getConnectionWithCredential.mockResolvedValue(Ok({id: 'conn-0', integrationId: 'linear', account: 'mcp.linear.app/mcp', credential: null}));
		const {cookie, state} = await start({connection: 'conn-0'});
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(findAccountConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), {
			integrationId: 'linear',
			account: 'alex@example.com · Acme',
			providerAccountId: null,
		});
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-5'});
		expect(createConnection).not.toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-5');
	});

	test('signing in to another workspace from a signed-in connection makes a connection of its own, the first kept', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({id: 'conn-0', integrationId: 'linear', account: 'alex@example.com · Beta', credential: 'enc:{}'}));
		const {cookie, state} = await start({connection: 'conn-0'});
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(findAccountConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), {
			integrationId: 'linear',
			account: 'alex@example.com · Acme',
			providerAccountId: null,
		});
		expect(renewConnection).not.toHaveBeenCalled();
		expect(createConnection.mock.calls[0]?.[0]).toMatchObject({integrationId: 'linear', account: 'alex@example.com · Acme'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-1?added');
	});

	test('a connection of another integration, or gone, is no connection to sign in again', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({id: 'conn-9', integrationId: 'notion', account: 'alex@example.com · Acme', credential: null}));
		const {cookie, state} = await start({connection: 'conn-9'});
		await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(renewConnection).not.toHaveBeenCalled();
		expect(createConnection.mock.calls[0]?.[0]).toMatchObject({integrationId: 'linear', account: 'alex@example.com · Acme'});
	});

	test('a sign-in turned down at Linear goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/new?error=linear');
		expect(createConnection).not.toHaveBeenCalled();
	});
});

describe('keyConnectRoute', () => {
	async function connectWithKey(body: unknown) {
		const {keyConnectRoute} = await import('../mcp/mcp-connect');
		const {LINEAR_MCP} = await import('./built-in');
		return keyConnectRoute(LINEAR_MCP)({user, body} as never);
	}

	test('connects with an API key, checked by listing the tools with it: the connection for who the key is, the key its credential', async () => {
		createConnection.mockImplementation(async (data: {integrationId: string; account: string; defaults: string[]}) =>
			Ok({id: 'conn-1', integrationId: data.integrationId, account: data.account, createdAt: new Date(), tools: null, name: null, defaults: data.defaults.map((actionId) => ({actionId}))}),
		);
		const connection = (await connectWithKey({key: 'lin_api_1234'})).unwrap();

		const calls = linear.requests.filter((request) => request.url.pathname === '/mcp');
		expect(calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer lin_api_1234', 'Bearer lin_api_1234', 'Bearer lin_api_1234']);
		expect(calls.map((call) => JSON.parse(call.body).method)).toEqual(['tools/list', 'tools/call', 'tools/call']);
		// The same account a sign-in would find: a key for it renews its connection.
		expect(findAccountConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), {
			integrationId: 'linear',
			account: 'alex@example.com · Acme',
			providerAccountId: null,
		});
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({integrationId: 'linear', account: 'alex@example.com · Acme', defaults: ['read']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toEqual({auth: 'key', key: 'lin_api_1234'});
		expect(connection).toMatchObject({id: 'conn-1', account: 'alex@example.com · Acme'});
	});

	test('a key Linear turns down is refused, and nothing saved', async () => {
		expect((await connectWithKey({key: 'bad-key'})).unwrapErr().kind).toBe('credentials_rejected');
		expect(createConnection).not.toHaveBeenCalled();
	});
});
