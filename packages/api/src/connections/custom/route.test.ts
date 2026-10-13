import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listConnections = mock();
const createConnection = mock();
const updateConnectionCredential = mock();
const getConnectionWithCredential = mock();
const updateConnectionTools = mock();
const updateConnectionName = mock();

// The authorization server, taking the registration a sign-in begins with.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	if (String(input) === 'https://mcp.example.com/register') {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	return new Response('Not found', {status: 404});
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

mock.module('@proxy/db/connection', () => ({listConnections, createConnection, updateConnectionCredential, getConnectionWithCredential, updateConnectionTools, updateConnectionName}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', ALLOW_PRIVATE_HOSTS: false}}));

// The example server is on the internet.
mock.module('node:dns/promises', () => ({default: {lookup: async () => [{address: '93.184.216.34', family: 4}]}}));

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

const search = {name: 'search_docs', title: 'Search docs', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}, annotations: {readOnlyHint: true}};
const publish = {name: 'publish_doc', inputSchema: {type: 'object'}};

const row = {
	id: 'mcp-1',
	integrationId: 'mcp',
	account: 'mcp.example.com/mcp',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	tools: JSON.stringify([search]),
	name: null,
	defaults: [{actionId: 'search_docs'}],
};

function makeRequest(body: unknown, params: Record<string, string> = {}) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params, body, query: {}, headers: {}} as never;
}

// What the connect route answered, and the cookies it set.
function makeRes() {
	const res = {
		cookies: [] as Array<{name: string; options: Record<string, unknown>}>,
		sent: undefined as unknown,
		statusCode: 200,
		cookie: mock((name: string, _value: string, options: Record<string, unknown>) => {
			res.cookies.push({name, options});
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
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockImplementation(async (data: {account: string; tools: string; defaults: string[]; name?: string}) =>
		Ok({...row, account: data.account, tools: data.tools, name: data.name ?? null, defaults: data.defaults.map((actionId) => ({actionId}))}),
	);
	updateConnectionCredential.mockResolvedValue(Ok(true));
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

describe('handleConnectCustomMcpRoute', () => {
	test('connects a server that answers without a sign-in, its tools kept and the ones that only read on by default', async () => {
		const res = await connect({name: 'Docs', url: 'https://mcp.example.com/mcp'});

		expect(probeMcpServer).toHaveBeenCalledWith(new URL('https://mcp.example.com/mcp'), null);
		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			integrationId: 'mcp',
			account: 'mcp.example.com/mcp',
			credential: `enc:${JSON.stringify({auth: 'none', url: 'https://mcp.example.com/mcp'})}`,
			defaults: ['search_docs'],
			tools: JSON.stringify([search, publish]),
			name: 'Docs',
		});
		expect(res.sent).toEqual({kind: 'connected', connection: {id: 'mcp-1', integrationId: 'mcp', account: 'mcp.example.com/mcp', defaults: ['search_docs'], tools: [search, publish], name: 'Docs'}});
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
		listConnections.mockResolvedValue(Ok([row]));
		const res = await connect({name: 'Docs again', url: 'https://mcp.example.com/mcp/'});

		expect(createConnection).not.toHaveBeenCalled();
		expect(updateConnectionName).toHaveBeenCalledWith({connectionId: 'mcp-1', name: 'Docs again'});
		expect(updateConnectionCredential).toHaveBeenCalledWith({connectionId: 'mcp-1', credential: `enc:${JSON.stringify({auth: 'none', url: 'https://mcp.example.com/mcp/'})}`});
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

	test('refuses an address that is not https, before asking anything', async () => {
		const res = await connect({name: 'Docs', url: 'http://mcp.example.com/mcp'});
		expect(res.statusCode).toBe(400);
		expect(res.sent).toMatchObject({error: 'validation_error'});
		expect(probeMcpServer).not.toHaveBeenCalled();
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
