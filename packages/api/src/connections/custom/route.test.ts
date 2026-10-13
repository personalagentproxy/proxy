import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listConnections = mock();
const createConnection = mock();
const updateConnectionCredential = mock();
const getConnectionWithCredential = mock();
const updateConnectionTools = mock();

mock.module('@proxy/db/connection', () => ({listConnections, createConnection, updateConnectionCredential, getConnectionWithCredential, updateConnectionTools}));

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

const probeMcpServer = mock();
const discoverMcpServer = mock();

const discovery = await import('./mcp-discovery');
mock.module('./mcp-discovery', () => ({...discovery, probeMcpServer, discoverMcpServer}));

const listCustomTools = mock();

const customMcp = await import('./custom-mcp');
mock.module('./custom-mcp', () => ({...customMcp, listCustomTools}));

const search = {name: 'search_docs', title: 'Search docs', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}, annotations: {readOnlyHint: true}};
const publish = {name: 'publish_doc', inputSchema: {type: 'object'}};

const row = {id: 'mcp-1', integrationId: 'mcp', account: 'mcp.example.com/mcp', createdAt: new Date('2026-10-01T00:00:00Z'), tools: JSON.stringify([search]), defaults: [{actionId: 'search_docs'}]};

function makeRequest(body: unknown, params: Record<string, string> = {}) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params, body, query: {}, headers: {}} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockImplementation(async (data: {account: string; tools: string; defaults: string[]}) =>
		Ok({...row, account: data.account, tools: data.tools, defaults: data.defaults.map((actionId) => ({actionId}))}),
	);
	updateConnectionCredential.mockResolvedValue(Ok(true));
	updateConnectionTools.mockResolvedValue(Ok(undefined));
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
		const {handleConnectCustomMcpRoute} = await import('./route');
		const result = (await handleConnectCustomMcpRoute(makeRequest({url: 'https://mcp.example.com/mcp'}))).unwrap();

		expect(probeMcpServer).toHaveBeenCalledWith(new URL('https://mcp.example.com/mcp'), null);
		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			integrationId: 'mcp',
			account: 'mcp.example.com/mcp',
			credential: `enc:${JSON.stringify({auth: 'none', url: 'https://mcp.example.com/mcp'})}`,
			defaults: ['search_docs'],
			tools: JSON.stringify([search, publish]),
		});
		expect(result).toEqual({kind: 'connected', connection: {id: 'mcp-1', integrationId: 'mcp', account: 'mcp.example.com/mcp', defaults: ['search_docs'], tools: [search, publish]}});
	});

	test('a token typed in is sent to the server and kept with the connection', async () => {
		const {handleConnectCustomMcpRoute} = await import('./route');
		(await handleConnectCustomMcpRoute(makeRequest({url: 'https://mcp.example.com/mcp?v=2', token: ' secret '}))).unwrap();

		expect(probeMcpServer).toHaveBeenCalledWith(new URL('https://mcp.example.com/mcp?v=2'), 'secret');
		expect(createConnection.mock.calls[0]?.[0]).toMatchObject({
			account: 'mcp.example.com/mcp',
			credential: `enc:${JSON.stringify({auth: 'token', url: 'https://mcp.example.com/mcp?v=2', token: 'secret'})}`,
		});
	});

	test('connecting the same address again replaces its credential and tools', async () => {
		listConnections.mockResolvedValue(Ok([row]));
		const {handleConnectCustomMcpRoute} = await import('./route');
		const result = (await handleConnectCustomMcpRoute(makeRequest({url: 'https://mcp.example.com/mcp/'}))).unwrap();

		expect(createConnection).not.toHaveBeenCalled();
		expect(updateConnectionCredential).toHaveBeenCalledWith({
			connectionId: 'mcp-1',
			credential: `enc:${JSON.stringify({auth: 'none', url: 'https://mcp.example.com/mcp/'})}`,
			tools: JSON.stringify([search, publish]),
		});
		expect(result).toMatchObject({kind: 'connected', connection: {id: 'mcp-1', tools: [search, publish]}});
	});

	test('a server that asks for a sign-in gets one, once its authorization server is found', async () => {
		probeMcpServer.mockResolvedValue(Ok({kind: 'signIn'}));
		const {handleConnectCustomMcpRoute} = await import('./route');
		expect((await handleConnectCustomMcpRoute(makeRequest({url: 'https://mcp.example.com/mcp'}))).unwrap()).toEqual({kind: 'signIn'});
		expect(createConnection).not.toHaveBeenCalled();

		discoverMcpServer.mockResolvedValue(Err(ApiErr.validationError('No registration')));
		expect((await handleConnectCustomMcpRoute(makeRequest({url: 'https://mcp.example.com/mcp'}))).unwrapErr().kind).toBe('validation_error');
	});

	test('refuses an address that is not https, before asking anything', async () => {
		const {handleConnectCustomMcpRoute} = await import('./route');
		expect((await handleConnectCustomMcpRoute(makeRequest({url: 'http://mcp.example.com/mcp'}))).unwrapErr().kind).toBe('validation_error');
		expect(probeMcpServer).not.toHaveBeenCalled();
	});
});

describe('handleRefreshCustomMcpToolsRoute', () => {
	test('asks the server for its tools again and keeps the new list', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...row, credential: 'enc:{}'}));
		listCustomTools.mockResolvedValue(Ok([search, publish]));
		const {handleRefreshCustomMcpToolsRoute} = await import('./route');
		const result = (await handleRefreshCustomMcpToolsRoute(makeRequest(undefined, {connectionId: 'mcp-1'}))).unwrap();

		expect(updateConnectionTools).toHaveBeenCalledWith({connectionId: 'mcp-1', tools: JSON.stringify([search, publish])});
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
