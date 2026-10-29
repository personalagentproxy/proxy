import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const createConnection = mock();
const renewConnection = mock();
const getConnectionWithCredential = mock();
const updateConnectionTools = mock();
const updateConnectionName = mock();

// The authorization servers, taking the registration a sign-in begins with.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	if (String(input).endsWith('/register')) {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	return new Response('Not found', {status: 404});
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

mock.module('@proxy/db/connection', () => ({
	findAccountConnection,
	createConnection,
	renewConnection,
	shareConnection: mock(),
	updateConnectionCredential: mock(),
	getConnectionWithCredential,
	updateConnectionTools,
	updateConnectionName,
	getConnectionCredential: mock(async () => Ok(null)),
}));

mock.module('@proxy/db/organization', () => ({getMembership: mock(async () => Ok({role: 'owner'})), listMemberNames: mock(async () => Ok([]))}));

const requireViewer = mock(async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}));

mock.module('../../utils/user-org', () => ({requireViewer, requireOwner: requireViewer}));

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const env = {NODE_ENV: 'production', APP_URL: 'https://app.example.com', ALLOW_PRIVATE_HOSTS: false};

mock.module('../../utils/env', () => ({env}));

// The example servers, and Personal Agent Proxy at app.example.com, are on the internet; one
// self-hosted at proxy.internal is on a private network.
mock.module('node:dns/promises', () => ({default: {lookup: async (host: string) => [{address: host === 'proxy.internal' ? '10.0.0.4' : '93.184.216.34', family: 4}]}}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const probeMcpServer = mock();
const discoverMcpServer = mock();

const discovery = await import('./mcp-discovery');
mock.module('./mcp-discovery', () => ({...discovery, probeMcpServer, discoverMcpServer}));

const listCustomTools = mock();

const customMcp = await import('./custom-mcp');
mock.module('./custom-mcp', () => ({...customMcp, listCustomTools}));

const exchangeMcpCode = mock();

const mcpOauth = await import('../mcp/mcp-oauth');
mock.module('../mcp/mcp-oauth', () => ({...mcpOauth, exchangeMcpCode}));

const listMcpTools = mock();
const callMcpTool = mock();

const mcpClient = await import('../mcp/mcp-client');
mock.module('../mcp/mcp-client', () => ({...mcpClient, listMcpTools, callMcpTool}));

// Linear names who a key is for.
const linearMcp = await import('../linear/linear-mcp');
mock.module('../linear/linear-mcp', () => ({...linearMcp, getLinearAccount: mock(async () => Ok('alex@example.com · Acme'))}));

// Of the integrations' modules, those built on their MCP servers, which take over a server's address.
const builtIns = await Promise.all([
	import('../cloudflare/built-in').then((module) => module.CLOUDFLARE_MCP),
	import('../exa/built-in').then((module) => module.EXA_MCP),
	import('../granola/built-in').then((module) => module.GRANOLA_MCP),
	import('../linear/built-in').then((module) => module.LINEAR_MCP),
	import('../notion/built-in').then((module) => module.NOTION_MCP),
	import('../parallel/built-in').then((module) => module.PARALLEL_MCP),
]);

mock.module('../integrations', () => ({apiIntegration: () => undefined, apiIntegrations: () => builtIns.map((builtInMcp) => ({id: builtInMcp.integrationId, connectors: {}, builtInMcp}))}));

const search = {name: 'search_docs', title: 'Search docs', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}, annotations: {readOnlyHint: true}};
const publish = {name: 'publish_doc', inputSchema: {type: 'object'}};

const row = {
	id: 'mcp-1',
	integrationId: 'mcp',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	connectedById: 'user-1',
	account: 'mcp.example.com/mcp',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	tools: JSON.stringify([search]),
	name: null,
	defaults: [{actionId: 'search_docs'}],
};

function makeRequest(body: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params, body, query, headers} as never;
}

// What the connect route answered, the cookies it set, and where the callback sent the browser.
function makeRes() {
	const res = {
		cookies: [] as Array<{name: string; value: string; options: Record<string, unknown>}>,
		sent: undefined as unknown,
		redirectedTo: undefined as string | undefined,
		statusCode: 200,
		cookie: mock((name: string, value: string, options: Record<string, unknown>) => {
			res.cookies.push({name, value, options});
		}),
		clearCookie: mock(),
		redirect: mock((url: string) => {
			res.redirectedTo = url;
		}),
		status: mock((code: number) => {
			res.statusCode = code;
			return res;
		}),
		json: mock((body: unknown) => {
			res.sent = body;
			return res;
		}),
	};
	return res;
}

async function connect(body: unknown) {
	const {handleConnectCustomMcpRoute} = await import('./route');
	const res = makeRes();
	await handleConnectCustomMcpRoute(makeRequest(body), res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	env.APP_URL = 'https://app.example.com';
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockImplementation(async (data: {account: string; tools: string; defaults: string[]; name?: string}) =>
		Ok({...row, account: data.account, tools: data.tools, name: data.name ?? null, defaults: data.defaults.map((actionId) => ({actionId}))}),
	);
	renewConnection.mockResolvedValue(Ok(undefined));
	updateConnectionTools.mockResolvedValue(Ok(undefined));
	updateConnectionName.mockResolvedValue(Ok(undefined));
	probeMcpServer.mockResolvedValue(Ok({kind: 'tools', tools: [search, publish]}));
	discoverMcpServer.mockResolvedValue(
		Ok({
			name: 'mcp.example.com',
			url: 'https://mcp.example.com/mcp',
			handshake: true,
			registerUrl: 'https://mcp.example.com/register',
			authorizeUrl: 'https://mcp.example.com/authorize',
			tokenUrl: 'https://mcp.example.com/token',
			scope: '',
		}),
	);
});

// A server whose authorization server takes a client ID metadata document and lets no app register.
const documentServer = {
	name: 'mcp.example.com',
	url: 'https://mcp.example.com/mcp',
	handshake: true,
	clientIdMetadataDocument: true,
	authorizeUrl: 'https://auth.example.com/oauth2/authorize',
	tokenUrl: 'https://auth.example.com/oauth2/token',
	scope: 'offline_access',
} as const;

describe('handleConnectCustomMcpRoute', () => {
	test('connects a server that answers without a sign-in, its tools kept and the ones that only read on by default', async () => {
		const res = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});

		expect(probeMcpServer).toHaveBeenCalledWith(new URL('https://mcp.example.com/mcp'), null);
		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			ownerUserId: 'user-1',
			connectedById: 'user-1',
			integrationId: 'mcp',
			account: 'mcp.example.com/mcp',
			providerAccountId: null,
			credential: `enc:${JSON.stringify({auth: 'none', url: 'https://mcp.example.com/mcp'})}`,
			defaults: ['search_docs'],
			tools: JSON.stringify([search, publish]),
			name: 'Docs',
		});
		expect(res.sent).toEqual({
			kind: 'connected',
			connection: {
				id: 'mcp-1',
				orgId: 'org-1',
				integrationId: 'mcp',
				account: 'mcp.example.com/mcp',
				shared: false,
				connectedById: 'user-1',
				connectedBy: null,
				defaults: ['search_docs'],
				tools: [search, publish],
				name: 'Docs',
				unavailable: [],
				signInNeeded: false,
			},
		});
	});

	test('the connection needs a name, as nothing a server says would do', async () => {
		const res = await connect({url: 'https://mcp.example.com/mcp'});
		expect(res.statusCode).toBe(400);
		expect(probeMcpServer).not.toHaveBeenCalled();

		const blank = await connect({name: '  ', url: 'https://mcp.example.com/mcp'});
		expect(blank.statusCode).toBe(400);
	});

	test('a token typed in is sent to the server and kept with the connection', async () => {
		await connect({name: 'Docs', url: 'https://mcp.example.com/mcp?v=2', token: ' secret '});

		expect(probeMcpServer).toHaveBeenCalledWith(new URL('https://mcp.example.com/mcp?v=2'), 'secret');
		expect(createConnection.mock.calls[0]?.[0]).toMatchObject({
			account: 'mcp.example.com/mcp',
			credential: `enc:${JSON.stringify({auth: 'token', url: 'https://mcp.example.com/mcp?v=2', token: 'secret'})}`,
		});
	});

	test('connecting the same address again replaces its credential and tools, the settings for tools no longer listed dropped', async () => {
		findAccountConnection.mockResolvedValue(Ok(row));
		const res = await connect({name: 'Docs again', url: 'https://mcp.example.com/mcp/'});

		expect(createConnection).not.toHaveBeenCalled();
		expect(updateConnectionName).toHaveBeenCalledWith({connectionId: 'mcp-1', name: 'Docs again'});
		expect(findAccountConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), {integrationId: 'mcp', account: 'mcp.example.com/mcp', providerAccountId: null});
		expect(renewConnection).toHaveBeenCalledWith({
			connectionId: 'mcp-1',
			account: 'mcp.example.com/mcp',
			providerAccountId: null,
			credential: `enc:${JSON.stringify({auth: 'none', url: 'https://mcp.example.com/mcp/'})}`,
		});
		expect(updateConnectionTools).toHaveBeenCalledWith({connectionId: 'mcp-1', tools: JSON.stringify([search, publish]), actions: ['search_docs', 'publish_doc']});
		expect(res.sent).toMatchObject({kind: 'connected', connection: {id: 'mcp-1', tools: [search, publish], name: 'Docs again'}});
	});

	test('a server that asks for a sign-in has it begun here, once its authorization server is found: the handshake in a cookie, its sign-in page answered', async () => {
		probeMcpServer.mockResolvedValue(Ok({kind: 'signIn'}));
		const res = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp', returnTo: 'welcome'});

		expect(createConnection).not.toHaveBeenCalled();
		expect(res.cookies[0]).toMatchObject({name: 'proxy.mcp-state', options: {httpOnly: true, sameSite: 'lax', path: '/api/connections/mcp'}});
		const sent = res.sent as {kind: string; url: string};
		expect(sent.kind).toBe('signIn');
		const authorizeUrl = new URL(sent.url);
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://mcp.example.com/authorize');
		expect(authorizeUrl.searchParams.get('client_id')).toBe('client-1');
		expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connections/mcp/callback');
		expect(authorizeUrl.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');

		discoverMcpServer.mockResolvedValue(Err(ApiErr.validationError('No registration')));
		const refused = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});
		expect(refused.statusCode).toBe(400);
		expect(refused.sent).toMatchObject({error: 'validation_error', message: 'No registration'});
	});

	test('an authorization server that takes a client ID metadata document is sent its address as the client, rather than one registered', async () => {
		probeMcpServer.mockResolvedValue(Ok({kind: 'signIn'}));
		discoverMcpServer.mockResolvedValue(Ok({...documentServer, registerUrl: 'https://auth.example.com/register'}));
		const res = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});

		const authorizeUrl = new URL((res.sent as {url: string}).url);
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://auth.example.com/oauth2/authorize');
		expect(authorizeUrl.searchParams.get('client_id')).toBe('https://app.example.com/oauth/client-metadata.json');
		expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connections/mcp/callback');
		expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizeUrl.searchParams.get('scope')).toBe('offline_access');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('a Personal Agent Proxy an authorization server could not fetch the document from registers a client instead, and can not sign in where that is the only way', async () => {
		probeMcpServer.mockResolvedValue(Ok({kind: 'signIn'}));
		discoverMcpServer.mockResolvedValue(Ok({...documentServer, registerUrl: 'https://auth.example.com/register'}));
		for (const appUrl of ['https://proxy.internal', 'http://localhost:5173']) {
			env.APP_URL = appUrl;
			const res = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});
			expect(new URL((res.sent as {url: string}).url).searchParams.get('client_id')).toBe('client-1');
			expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toBe('https://auth.example.com/register');
		}

		discoverMcpServer.mockResolvedValue(Ok(documentServer));
		const refused = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});
		expect(refused.statusCode).toBe(400);
		expect(refused.sent).toMatchObject({error: 'validation_error'});
		expect(refused.cookies).toEqual([]);
	});

	test('refuses an address that is not https, before asking anything', async () => {
		const res = await connect({name: 'Docs', url: 'http://mcp.example.com/mcp'});
		expect(res.statusCode).toBe(400);
		expect(res.sent).toMatchObject({error: 'validation_error'});
		expect(probeMcpServer).not.toHaveBeenCalled();
	});

	test('the server of an integration that is built in, whatever its path or query, is signed in to as that integration instead', async () => {
		for (const [url, integrationId, authorize] of [
			['https://mcp.exa.ai/mcp?tools=web_search_exa', 'exa', 'https://auth.exa.ai/oauth/authorize'],
			['https://search.parallel.ai/mcp', 'parallel', 'https://platform.parallel.ai/getKeys/authorize'],
			['https://mcp.linear.app/sse', 'linear', 'https://mcp.linear.app/authorize'],
		] as const) {
			const res = await connect({name: 'Search', url});
			expect(res.sent).toMatchObject({kind: 'signIn'});
			const signIn = new URL((res.sent as {url: string}).url);
			expect(signIn.origin + signIn.pathname).toBe(authorize);
			expect(signIn.searchParams.get('redirect_uri')).toBe(`https://app.example.com/api/connections/${integrationId}/callback`);
			expect(res.cookies.map((cookie) => [cookie.name, cookie.options.path])).toEqual([[`proxy.${integrationId}-state`, `/api/connections/${integrationId}`]]);
		}
		expect(probeMcpServer).not.toHaveBeenCalled();
		expect(createConnection).not.toHaveBeenCalled();
	});

	test("a token typed in for a built-in integration's server connects the integration with it as its API key, under the name given", async () => {
		callMcpTool.mockResolvedValue(Ok('# Example Domain'));
		listMcpTools.mockResolvedValue(Ok([]));
		for (const [url, integrationId, account] of [
			['https://mcp.exa.ai/mcp', 'exa', 'API key ending 1234'],
			['https://search.parallel.ai/mcp', 'parallel', 'API key ending 1234'],
			['https://mcp.linear.app/sse', 'linear', 'alex@example.com · Acme'],
		] as const) {
			const res = await connect({name: 'Web search', url, token: 'key-1234'});
			expect(res.sent).toMatchObject({kind: 'connected', connection: {name: 'Web search', account}});
			expect(createConnection.mock.calls.at(-1)?.[0]).toMatchObject({integrationId, name: 'Web search', credential: `enc:${JSON.stringify({auth: 'key', key: 'key-1234'})}`});
		}
		expect(probeMcpServer).not.toHaveBeenCalled();
	});

	test('a token for an account already connected gives that connection the key, its own name kept rather than the one typed', async () => {
		listMcpTools.mockResolvedValue(Ok([]));
		findAccountConnection.mockResolvedValue(Ok({...row, id: 'linear-1', integrationId: 'linear', account: 'alex@example.com · Acme', tools: null, name: 'Work'}));
		const res = await connect({name: 'Linear test', url: 'https://mcp.linear.app/mcp', token: 'key-1234'});

		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'linear-1', credential: `enc:${JSON.stringify({auth: 'key', key: 'key-1234'})}`});
		expect(updateConnectionName).not.toHaveBeenCalled();
		expect(res.sent).toMatchObject({kind: 'connected', connection: {id: 'linear-1', name: 'Work', account: 'alex@example.com · Acme'}});
	});

	test("a key in the address, as Exa's own setup writes it, connects the integration with it as its API key", async () => {
		callMcpTool.mockResolvedValue(Ok('# Example Domain'));
		const res = await connect({name: 'Web search', url: 'https://mcp.exa.ai/mcp?exaApiKey=key-5678'});

		expect(res.sent).toMatchObject({kind: 'connected', connection: {name: 'Web search', account: 'API key ending 5678'}});
		expect(createConnection.mock.calls.at(-1)?.[0]).toMatchObject({integrationId: 'exa', credential: `enc:${JSON.stringify({auth: 'key', key: 'key-5678'})}`});
	});

	test('a token for a built-in integration that takes no key is refused, rather than dropped for a sign-in', async () => {
		const res = await connect({name: 'Notes', url: 'https://mcp.notion.com/mcp', token: 'secret_1234'});

		expect(res.sent).toMatchObject({error: 'validation_error', message: 'Notion is connected by signing in to it, so leave the token out'});
		expect(res.cookies).toEqual([]);
		expect(createConnection).not.toHaveBeenCalled();
	});
});

describe('handleCustomMcpCallbackRoute', () => {
	test('a sign-in begun on the connect route comes back to the server it found, connected under the name given, its endpoints kept beside the tokens', async () => {
		probeMcpServer.mockResolvedValue(Ok({kind: 'signIn'}));
		const begun = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});
		const state = new URL((begun.sent as {url: string}).url).searchParams.get('state') ?? '';
		const cookie = `proxy.mcp-state=${encodeURIComponent(begun.cookies[0]?.value ?? '')}`;

		const tokens = {clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null};
		exchangeMcpCode.mockResolvedValue(Ok(tokens));
		listMcpTools.mockResolvedValue(Ok([search, publish]));
		const {handleCustomMcpCallbackRoute} = await import('./route');
		const res = makeRes();
		await handleCustomMcpCallbackRoute(makeRequest(undefined, {}, {state, code: 'code-1'}, {cookie}), res as never);

		const endpoints = {
			name: 'mcp.example.com',
			url: 'https://mcp.example.com/mcp',
			registerUrl: 'https://mcp.example.com/register',
			authorizeUrl: 'https://mcp.example.com/authorize',
			tokenUrl: 'https://mcp.example.com/token',
			scope: '',
			handshake: true,
		};
		expect(exchangeMcpCode).toHaveBeenCalledWith(endpoints, {clientId: 'client-1', redirectUri: 'https://app.example.com/api/connections/mcp/callback', code: 'code-1', verifier: expect.any(String)});
		expect(listMcpTools).toHaveBeenCalledWith(endpoints, 'access-1');
		const created = createConnection.mock.calls[0]?.[0] as {credential: string};
		expect(created).toMatchObject({account: 'mcp.example.com/mcp', providerAccountId: null, defaults: ['search_docs'], tools: JSON.stringify([search, publish]), name: 'Docs'});
		expect(JSON.parse(created.credential.replace(/^enc:/, ''))).toEqual({auth: 'oauth', url: 'https://mcp.example.com/mcp', server: endpoints, ...tokens});
		expect(res.redirectedTo).toBe('https://app.example.com/org-1/connections/mcp-1?added');
	});
	test('a sign-in made with the client ID metadata document keeps its address as the client, which refreshing sends', async () => {
		probeMcpServer.mockResolvedValue(Ok({kind: 'signIn'}));
		discoverMcpServer.mockResolvedValue(Ok(documentServer));
		const begun = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});
		const state = new URL((begun.sent as {url: string}).url).searchParams.get('state') ?? '';
		const cookie = `proxy.mcp-state=${encodeURIComponent(begun.cookies[0]?.value ?? '')}`;

		const clientId = 'https://app.example.com/oauth/client-metadata.json';
		const tokens = {clientId, accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null};
		exchangeMcpCode.mockResolvedValue(Ok(tokens));
		listMcpTools.mockResolvedValue(Ok([search]));
		const {handleCustomMcpCallbackRoute} = await import('./route');
		const res = makeRes();
		await handleCustomMcpCallbackRoute(makeRequest(undefined, {}, {state, code: 'code-1'}, {cookie}), res as never);

		expect(exchangeMcpCode).toHaveBeenCalledWith(documentServer, {clientId, redirectUri: 'https://app.example.com/api/connections/mcp/callback', code: 'code-1', verifier: expect.any(String)});
		const created = createConnection.mock.calls[0]?.[0] as {credential: string};
		const stored = customMcp.customCredentialSchema.parse(JSON.parse(created.credential.replace(/^enc:/, '')));
		expect(stored).toEqual({auth: 'oauth', url: 'https://mcp.example.com/mcp', server: documentServer, ...tokens});

		fetchSpy.mockImplementationOnce((async (_input: string | URL | Request) => Response.json({access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600})) as typeof fetch);
		if (stored.auth !== 'oauth') {
			throw new Error('Not signed in');
		}
		const refreshed = (await mcpOauth.refreshMcpTokens({...customMcp.customEndpoint(stored.url), ...stored.server}, stored)).unwrap();
		expect(refreshed).toMatchObject({clientId, accessToken: 'access-2', refreshToken: 'refresh-2'});
		const [refreshUrl, refreshInit] = fetchSpy.mock.calls.at(-1) ?? [];
		expect(String(refreshUrl)).toBe('https://auth.example.com/oauth2/token');
		expect(new URLSearchParams(String(refreshInit?.body)).get('client_id')).toBe(clientId);
		expect(new URLSearchParams(String(refreshInit?.body)).get('grant_type')).toBe('refresh_token');
	});
});

describe('handleRefreshCustomMcpToolsRoute', () => {
	test('asks the server for its tools again and keeps the new list', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...row, credential: 'enc:{}'}));
		listCustomTools.mockResolvedValue(Ok([search, publish]));
		const {handleRefreshCustomMcpToolsRoute} = await import('./route');
		const result = (await handleRefreshCustomMcpToolsRoute(makeRequest(undefined, {connectionId: 'mcp-1'}))).unwrap();

		expect(updateConnectionTools).toHaveBeenCalledWith({connectionId: 'mcp-1', tools: JSON.stringify([search, publish]), actions: ['search_docs', 'publish_doc']});
		expect(result.tools).toEqual([search, publish]);
		expect(result.defaults).toEqual(['search_docs']);
	});

	test('only a custom MCP server has tools to ask for', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...row, integrationId: 'email', tools: null, credential: 'enc:{}'}));
		const {handleRefreshCustomMcpToolsRoute} = await import('./route');
		expect((await handleRefreshCustomMcpToolsRoute(makeRequest(undefined, {connectionId: 'mcp-1'}))).unwrapErr().kind).toBe('validation_error');
		expect(listCustomTools).not.toHaveBeenCalled();
	});
});
