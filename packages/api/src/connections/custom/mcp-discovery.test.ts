import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';

const env = {NODE_ENV: 'production', APP_URL: 'https://app.example.com', ALLOW_PRIVATE_HOSTS: false};

mock.module('../../utils/env', () => ({env}));

// What the hosts resolve to: the example servers on the internet, localhost on this machine.
const ADDRESSES: Record<string, string> = {'mcp.example.com': '93.184.216.34', 'auth.example.com': '93.184.216.35', localhost: '127.0.0.1'};

mock.module('node:dns/promises', () => ({
	default: {
		lookup: async (host: string) => {
			const address = ADDRESSES[host];
			if (!address) {
				throw new Error(`ENOTFOUND ${host}`);
			}
			return [{address, family: 4}];
		},
	},
}));

// The server and its authorization server: each request, and what each address answers.
const servers = {requests: [] as Array<{url: string; method: string; headers: Headers; body: string}>, answers: new Map<string, () => Response>()};

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	servers.requests.push({url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : ''});
	return servers.answers.get(url)?.() ?? new Response('Not found', {status: 404});
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	servers.requests = [];
	servers.answers = new Map();
	env.ALLOW_PRIVATE_HOSTS = false;
});

const MCP_URL = 'https://mcp.example.com/mcp';

const tool = {name: 'search_docs', description: 'Searches the docs.', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}, annotations: {readOnlyHint: true}};

function jsonRpc(id: number, result: object): Response {
	return Response.json({jsonrpc: '2.0', id, result});
}

// A server that answers every call as a stateless one does: initialize, then the tools asked for.
function openServer(): void {
	servers.answers.set(MCP_URL, () => {
		const request = servers.requests.at(-1);
		const message = JSON.parse(request?.body || '{}') as {id?: number; method?: string};
		if (message.method === 'initialize') {
			return jsonRpc(1, {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'docs', version: '1'}});
		}
		if (message.method === 'notifications/initialized') {
			return new Response(null, {status: 202});
		}
		return jsonRpc(message.id ?? 1, {tools: [tool]});
	});
}

describe('parseMcpServerUrl', () => {
	test('takes an https address on the internet, keeping its query and dropping its fragment', async () => {
		const {parseMcpServerUrl} = await import('./mcp-discovery');
		expect((await parseMcpServerUrl(' https://mcp.example.com/mcp?key=1#x ')).unwrap().toString()).toBe('https://mcp.example.com/mcp?key=1');
	});

	test('refuses what is not an address, sign-in details in it, and http to a server on the internet', async () => {
		const {parseMcpServerUrl} = await import('./mcp-discovery');
		expect((await parseMcpServerUrl('not a url')).unwrapErr().kind).toBe('validation_error');
		expect((await parseMcpServerUrl('ftp://mcp.example.com/mcp')).unwrapErr().kind).toBe('validation_error');
		expect((await parseMcpServerUrl('https://user:pass@mcp.example.com/mcp')).unwrapErr().kind).toBe('validation_error');
		expect((await parseMcpServerUrl('http://mcp.example.com/mcp')).unwrapErr().kind).toBe('validation_error');
		expect((await parseMcpServerUrl('https://nowhere.example.com/mcp')).unwrapErr().kind).toBe('validation_error');
	});

	test('refuses a private address, as a database host is refused, unless ALLOW_PRIVATE_HOSTS says so, and then takes http to it', async () => {
		const {parseMcpServerUrl} = await import('./mcp-discovery');
		expect((await parseMcpServerUrl('https://10.0.0.7/mcp')).unwrapErr().kind).toBe('validation_error');
		expect((await parseMcpServerUrl('http://localhost:3000/mcp')).unwrapErr().kind).toBe('validation_error');

		env.ALLOW_PRIVATE_HOSTS = true;
		expect((await parseMcpServerUrl('http://localhost:3000/mcp')).unwrap().toString()).toBe('http://localhost:3000/mcp');
		expect((await parseMcpServerUrl('http://[::1]:3000/mcp')).unwrap().toString()).toBe('http://[::1]:3000/mcp');
		expect((await parseMcpServerUrl('http://mcp.example.com/mcp')).unwrapErr().kind).toBe('validation_error');
	});
});

describe('probeMcpServer', () => {
	test('a server that answers gives its tools; one that turns a request without a token down asks for a sign-in', async () => {
		const {probeMcpServer} = await import('./mcp-discovery');
		openServer();
		expect((await probeMcpServer(new URL(MCP_URL), null)).unwrap()).toEqual({kind: 'tools', tools: [tool]});
		expect(servers.requests[0]?.headers.has('authorization')).toBe(false);

		servers.answers.set(MCP_URL, () => new Response('Unauthorized', {status: 401}));
		expect((await probeMcpServer(new URL(MCP_URL), null)).unwrap()).toEqual({kind: 'signIn'});
	});

	test('a token the server turns down is rejected credentials, and one it takes is sent as a bearer token', async () => {
		const {probeMcpServer} = await import('./mcp-discovery');
		servers.answers.set(MCP_URL, () => new Response('Unauthorized', {status: 401}));
		expect((await probeMcpServer(new URL(MCP_URL), 'secret')).unwrapErr().kind).toBe('credentials_rejected');

		openServer();
		(await probeMcpServer(new URL(MCP_URL), 'secret')).unwrap();
		expect(servers.requests.at(-1)?.headers.get('authorization')).toBe('Bearer secret');
	});
});

describe('discoverMcpServer', () => {
	test("finds the authorization server the 401's resource metadata points at, and its endpoints from its metadata", async () => {
		const {discoverMcpServer} = await import('./mcp-discovery');
		servers.answers.set(
			MCP_URL,
			() => new Response('Unauthorized', {status: 401, headers: {'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'}}),
		);
		servers.answers.set('https://mcp.example.com/.well-known/oauth-protected-resource/mcp', () =>
			Response.json({resource: MCP_URL, authorization_servers: ['https://auth.example.com/tenant'], scopes_supported: ['docs:read', 'docs:write']}),
		);
		servers.answers.set('https://auth.example.com/.well-known/oauth-authorization-server/tenant', () =>
			Response.json({
				issuer: 'https://auth.example.com/tenant',
				authorization_endpoint: 'https://auth.example.com/tenant/oauth/authorize',
				token_endpoint: 'https://auth.example.com/tenant/oauth/token',
				registration_endpoint: 'https://auth.example.com/tenant/oauth/register',
			}),
		);

		const server = (await discoverMcpServer(new URL(MCP_URL))).unwrap();
		expect(server).toMatchObject({
			name: 'mcp.example.com',
			url: MCP_URL,
			handshake: true,
			registerUrl: 'https://auth.example.com/tenant/oauth/register',
			authorizeUrl: 'https://auth.example.com/tenant/oauth/authorize',
			tokenUrl: 'https://auth.example.com/tenant/oauth/token',
			scope: 'docs:read docs:write',
		});
	});

	test('falls back to the well-known paths, then to the server itself with the usual endpoints', async () => {
		const {discoverMcpServer} = await import('./mcp-discovery');
		servers.answers.set(MCP_URL, () => new Response('Unauthorized', {status: 401}));
		servers.answers.set('https://mcp.example.com/.well-known/oauth-protected-resource', () => Response.json({authorization_servers: ['https://mcp.example.com']}));
		servers.answers.set('https://mcp.example.com/.well-known/openid-configuration', () =>
			Response.json({
				authorization_endpoint: 'https://mcp.example.com/authorize',
				token_endpoint: 'https://mcp.example.com/token',
				registration_endpoint: 'https://mcp.example.com/register',
				scopes_supported: ['openid'],
			}),
		);
		expect((await discoverMcpServer(new URL(MCP_URL))).unwrap()).toMatchObject({registerUrl: 'https://mcp.example.com/register', scope: 'openid'});

		servers.answers = new Map([[MCP_URL, () => new Response('Unauthorized', {status: 401})]]);
		expect((await discoverMcpServer(new URL(MCP_URL))).unwrap()).toMatchObject({
			registerUrl: 'https://mcp.example.com/register',
			authorizeUrl: 'https://mcp.example.com/authorize',
			tokenUrl: 'https://mcp.example.com/token',
			scope: '',
		});
	});

	test('an authorization server that does not let apps register themselves, or is not https, cannot be signed in to', async () => {
		const {discoverMcpServer} = await import('./mcp-discovery');
		servers.answers.set('https://mcp.example.com/.well-known/oauth-protected-resource', () => Response.json({authorization_servers: ['https://auth.example.com']}));
		servers.answers.set('https://auth.example.com/.well-known/oauth-authorization-server', () =>
			Response.json({authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token'}),
		);
		const refused = (await discoverMcpServer(new URL(MCP_URL))).unwrapErr();
		expect(refused.kind).toBe('validation_error');
		expect('message' in refused && refused.message).toContain('register');

		servers.answers.set('https://mcp.example.com/.well-known/oauth-protected-resource', () => Response.json({authorization_servers: ['http://auth.example.com']}));
		expect((await discoverMcpServer(new URL(MCP_URL))).unwrapErr().kind).toBe('validation_error');
	});
});
