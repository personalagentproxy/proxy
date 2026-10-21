import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const createConnection = mock();
const renewConnection = mock();
const updateConnectionName = mock();

const getConnectionWithCredential = mock();

mock.module('@proxy/db/connection', () => ({
	getConnectionWithCredential,
	findAccountConnection,
	createConnection,
	renewConnection,
	updateConnectionCredential: mock(),
	getConnectionCredential: mock(async () => Ok(null)),
	updateConnectionTools: mock(),
	updateConnectionName,
}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId, getMembership: mock(async () => Ok({role: 'owner'})), listMemberNames: mock(async () => Ok([]))}));

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

const CALLBACK = 'https://app.example.com/api/connections/exa/callback';

// Exa's authorization server: each request, and its answers.
const exa = {requests: [] as Array<{url: URL; body: string}>};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	exa.requests.push({url, body: typeof init?.body === 'string' ? init.body : ''});
	if (url.pathname === '/api/oauth/register') {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	if (url.host === 'mcp.exa.ai') {
		// Exa's server answers anyone; a key it turns down fails the tool call.
		const authorization = new Headers(init?.headers).get('authorization');
		if (authorization === 'Bearer bad-key') {
			return Response.json({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: 'web_fetch_exa error (401): Invalid API key. Provide a valid key.'}], isError: true}});
		}
		if (authorization === 'Bearer narrow-key') {
			return new Response('Forbidden', {status: 403, headers: {'www-authenticate': 'Bearer error="insufficient_scope", error_description="This key cannot read pages"'}});
		}
		if (authorization === 'Bearer busy-key-4321') {
			return Response.json({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: 'Error fetching URL(s): example.com timeout'}], isError: true}});
		}
		return Response.json({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: '# Example Domain\nURL: https://example.com\n\nExample'}]}});
	}
	return Response.json({access_token: 'access-1', token_type: 'bearer'});
}) as typeof fetch);

// The sign-in routes the api makes of Exa's declaration.
async function routes() {
	const {mcpConnectRoutes} = await import('../mcp/mcp-connect');
	const {EXA_MCP} = await import('./route');
	return mcpConnectRoutes(EXA_MCP);
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
	const {handleStart: handleStartExaRoute} = await routes();
	const res = makeRes();
	await handleStartExaRoute({user, query, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.exa-state');
	const authorizeUrl = new URL(res.redirect.mock.calls[0]?.[0] as string);
	return {cookie, authorizeUrl, state: authorizeUrl.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const {handleCallback: handleExaCallbackRoute} = await routes();
	const res = makeRes();
	await handleExaCallbackRoute({user, query: args.query, headers: {cookie: `proxy.exa-state=${args.cookie}`}} as never, res as never);
	return res;
}

// What a connection made with a key answers, from what was saved.
async function connectWithKey(body: unknown) {
	const {keyConnectRoute} = await import('../mcp/mcp-connect');
	const {EXA_MCP} = await import('./route');
	return keyConnectRoute(EXA_MCP)({user, body} as never);
}

const existing = {
	id: 'conn-0',
	integrationId: 'exa',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	connectedById: 'user-1',
	account: 'Signed in',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	tools: null,
	name: 'Team Exa',
	defaults: [{actionId: 'search'}],
	credential: 'enc:{}',
};

beforeEach(() => {
	mock.clearAllMocks();
	exa.requests = [];
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockImplementation(async (data: {integrationId: string; account: string; defaults: string[]; name?: string}) =>
		Ok({id: 'conn-1', integrationId: data.integrationId, account: data.account, createdAt: new Date(), tools: null, name: data.name ?? null, defaults: data.defaults.map((actionId) => ({actionId}))}),
	);
	getConnectionWithCredential.mockResolvedValue(Ok(null));
	renewConnection.mockResolvedValue(Ok(undefined));
});

describe('handleStartExaRoute', () => {
	test("registers with Exa's authorization server and sends the browser to its sign-in with PKCE", async () => {
		const {cookie, authorizeUrl} = await start();

		expect(exa.requests[0]?.url.href).toBe('https://auth.exa.ai/api/oauth/register');
		expect(JSON.parse(exa.requests[0]?.body ?? '{}')).toMatchObject({redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none'});
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://auth.exa.ai/oauth/authorize');
		expect(authorizeUrl.searchParams.get('client_id')).toBe('client-1');
		expect(authorizeUrl.searchParams.get('scope')).toBe('mcp:tools');
		expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizeUrl.searchParams.get('resource')).toBe('https://mcp.exa.ai/mcp');
		expect(cookie?.options).toMatchObject({httpOnly: true, path: '/api/connections/exa'});
	});
});

describe('handleExaCallbackRoute', () => {
	test('makes the connection, agents searching the web and reading pages', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(exa.requests.at(-1)?.url.href).toBe('https://auth.exa.ai/api/oauth/token');
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'exa', account: 'Signed in', defaults: ['search', 'fetch']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toMatchObject({clientId: 'client-1', refreshToken: null, expiresAt: null});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-1?added');
	});

	test('signing in from the catalog again makes another connection, since Exa says nothing of who signed in', async () => {
		const {cookie, state} = await start();
		await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(findAccountConnection).not.toHaveBeenCalled();
		expect(createConnection).toHaveBeenCalledTimes(1);
	});

	test("begun from a connection's page (`?connection=`), the sign-in gives that connection the new tokens, its name kept", async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(existing));
		const {cookie, state} = await start({connection: 'conn-0'});
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(getConnectionWithCredential).toHaveBeenCalledWith({orgId: 'org-1', userId: 'user-1'}, 'conn-0');
		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0', account: 'Signed in'});
		expect(updateConnectionName).not.toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-0');
	});

	test('a sign-in begun on the custom MCP form makes the connection under the name typed there', async () => {
		const {beginBuiltInSignIn} = await import('../mcp/mcp-connect');
		const {EXA_MCP} = await import('./route');
		const begun = makeRes();
		const url = new URL((await beginBuiltInSignIn(EXA_MCP, begun as never, {viewer: {orgId: 'org-1', userId: 'user-1'}, returnTo: undefined, name: 'Web search', shared: false})).unwrap());
		const cookie = begun.cookies.find((candidate) => candidate.name === 'proxy.exa-state');
		await callback({cookie: cookie?.value ?? '', query: {state: url.searchParams.get('state') ?? '', code: 'code-1'}});

		expect(createConnection.mock.calls[0]?.[0]).toMatchObject({integrationId: 'exa', account: 'Signed in', name: 'Web search', defaults: ['search', 'fetch']});
	});

	test('a sign-in turned down at Exa goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/new?error=exa');
		expect(createConnection).not.toHaveBeenCalled();
	});
});

describe('keyConnectRoute', () => {
	test('connects with an API key, checked by reading a page with it: the key its credential, its end its account', async () => {
		const connection = (await connectWithKey({key: 'exa-key-1234'})).unwrap();

		expect(exa.requests.at(-1)?.url.href).toBe('https://mcp.exa.ai/mcp');
		expect(JSON.parse(exa.requests.at(-1)?.body ?? '{}')).toMatchObject({method: 'tools/call', params: {name: 'web_fetch_exa', arguments: {urls: ['https://example.com']}}});
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'exa', account: 'API key ending 1234', defaults: ['search', 'fetch']});
		expect(created.name).toBeUndefined();
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toEqual({auth: 'key', key: 'exa-key-1234'});
		expect(connection).toMatchObject({id: 'conn-1', name: null, unavailable: []});
	});

	test('a key Exa turns down is refused, and nothing saved', async () => {
		const error = (await connectWithKey({key: 'bad-key'})).unwrapErr();

		expect(error.kind).toBe('credentials_rejected');
		expect(createConnection).not.toHaveBeenCalled();
	});

	test('a key Exa refuses the request of, lacking a permission, is refused, and nothing saved', async () => {
		const error = (await connectWithKey({key: 'narrow-key'})).unwrapErr();

		expect(error).toMatchObject({kind: 'validation_error', message: expect.stringContaining('This key cannot read pages')});
		expect(createConnection).not.toHaveBeenCalled();
	});

	test("a page Exa couldn't read with the key says nothing against the key, which connects", async () => {
		const connection = (await connectWithKey({key: 'busy-key-4321'})).unwrap();

		expect(connection).toMatchObject({id: 'conn-1', account: 'API key ending 4321'});
	});

	test("given a connection (`connection`), the key replaces that connection's credential, its name kept", async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(existing));
		const connection = (await connectWithKey({connection: 'conn-0', key: 'exa-key-5678'})).unwrap();

		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0', account: 'API key ending 5678', credential: `enc:${JSON.stringify({auth: 'key', key: 'exa-key-5678'})}`});
		expect(updateConnectionName).not.toHaveBeenCalled();
		expect(connection).toMatchObject({id: 'conn-0', name: 'Team Exa'});
	});

	test('a key alone makes a connection with no name of its own, and a key has no spaces', async () => {
		const connection = (await connectWithKey({key: 'exa-key-9999'})).unwrap();
		expect(connection).toMatchObject({name: null, account: 'API key ending 9999'});
		expect((await connectWithKey({key: 'Basic abc'})).unwrapErr().kind).toBe('validation_error');
	});
});
