import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listCustomMcpConnections = mock();
const takeOverConnection = mock();

mock.module('@proxy/db/connection', () => ({
	listCustomMcpConnections,
	takeOverConnection,
	findAccountConnection: mock(),
	getConnectionWithCredential: mock(),
	createConnection: mock(),
	renewConnection: mock(),
	shareConnection: mock(),
	updateConnectionCredential: mock(),
	getConnectionCredential: mock(async () => Ok(null)),
	updateConnectionTools: mock(),
	updateConnectionName: mock(),
}));

// The servers, as a key is checked with them: one starting "bad-" is turned down at the door, and
// Exa, which answers anyone until a tool is called, turns it down then.
const rejected = (key: string | null) => key?.startsWith('bad-') === true;
mock.module('./mcp/mcp-client', () => ({
	callMcpTool: mock(async (_server: unknown, key: string | null) => (rejected(key) ? Err(ApiErr.credentialsRejected()) : Ok('# Example Domain'))),
	listMcpTools: mock(async (_server: unknown, key: string | null) => (rejected(key) ? Err(ApiErr.credentialsRejected()) : Ok([]))),
	parseToolJson: mock(),
}));

// Linear names who a key is for, and Notion who signed in and the workspace, for the access token
// it is asked with; one it doesn't take is turned down.
const linearMcp = await import('./linear/linear-mcp');
mock.module('./linear/linear-mcp', () => ({...linearMcp, getLinearAccount: mock(async () => Ok('alex@example.com · Acme'))}));
const notionMcp = await import('./notion/notion-mcp');
mock.module('./notion/notion-mcp', () => ({
	...notionMcp,
	getNotionAccount: mock(async (accessToken: string) => {
		if (accessToken.startsWith('down-')) {
			return Err(ApiErr.providerUnreachable(new Error('Notion is down')));
		}
		return accessToken.startsWith('access-') ? Ok('alex@example.com · Acme') : Err(ApiErr.credentialsRejected());
	}),
}));

// Notion's token endpoint: refreshes the tokens, a new refresh token each time, but not for a
// sign-in it revoked.
const tokenRequests: string[] = [];
spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
	tokenRequests.push(String(input));
	if (body.get('refresh_token') === 'revoked') {
		return Response.json({error: 'invalid_grant'}, {status: 400});
	}
	if (body.get('refresh_token') === 'refresh-down') {
		return Response.json({access_token: 'down-2', refresh_token: 'refresh-3', expires_in: 3600, token_type: 'bearer'});
	}
	return Response.json({access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'bearer'});
}) as typeof fetch);

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

// Of the integrations' modules, those built on their MCP servers, which take over a server's address.
const builtIns = await Promise.all([
	import('./cloudflare/built-in').then((module) => module.CLOUDFLARE_MCP),
	import('./exa/built-in').then((module) => module.EXA_MCP),
	import('./granola/built-in').then((module) => module.GRANOLA_MCP),
	import('./linear/built-in').then((module) => module.LINEAR_MCP),
	import('./notion/built-in').then((module) => module.NOTION_MCP),
	import('./parallel/built-in').then((module) => module.PARALLEL_MCP),
]);

mock.module('./integrations', () => ({apiIntegration: () => undefined, apiIntegrations: () => builtIns.map((builtInMcp) => ({id: builtInMcp.integrationId, connectors: {}, builtInMcp}))}));

const {movedCredential, movedPermissions, movedRun, takeOverCustomConnections} = await import('./take-over-custom');
const {CLOUDFLARE_MCP} = await import('./cloudflare/built-in');
const {EXA_MCP} = await import('./exa/built-in');
const {LINEAR_MCP} = await import('./linear/built-in');
const {PARALLEL_MCP} = await import('./parallel/built-in');

const LINEAR_ACTIONS = ['read', 'create', 'edit'];

function stored(credential: object): string {
	return `enc:${JSON.stringify(credential)}`;
}

const EXA_SIGN_IN = {
	auth: 'oauth' as const,
	url: 'https://mcp.exa.ai/mcp',
	server: {
		name: 'mcp.exa.ai',
		url: 'https://mcp.exa.ai/mcp',
		registerUrl: 'https://auth.exa.ai/api/oauth/register',
		authorizeUrl: 'https://auth.exa.ai/oauth/authorize',
		tokenUrl: 'https://auth.exa.ai/api/oauth/token',
		scope: 'mcp:tools',
		handshake: true as const,
	},
	clientId: 'client-1',
	accessToken: 'access-1',
	refreshToken: 'refresh-1',
	expiresAt: null,
};

describe('movedPermissions', () => {
	test('an action is on where every tool of it the server listed was, by default and for each agent', () => {
		const moved = movedPermissions(LINEAR_MCP, LINEAR_ACTIONS, {
			listed: ['list_issues', 'get_issue', 'save_issue', 'create_comment'],
			defaults: ['list_issues', 'get_issue'],
			grants: [
				{agentId: 'agent-a', actionId: 'save_issue', allowed: true},
				{agentId: 'agent-b', actionId: 'get_issue', allowed: false},
				{agentId: 'agent-c', actionId: 'create_comment', allowed: true},
			],
		});

		expect(moved.defaults).toEqual(['read']);
		expect(moved.grants).toEqual([
			{agentId: 'agent-a', actionId: 'create', allowed: true},
			{agentId: 'agent-a', actionId: 'edit', allowed: true},
			{agentId: 'agent-b', actionId: 'read', allowed: false},
		]);
	});

	test('never allows more than before: an action with one of its tools off is off', () => {
		const moved = movedPermissions(LINEAR_MCP, LINEAR_ACTIONS, {
			listed: ['list_issues', 'get_issue'],
			defaults: ['list_issues'],
			grants: [{agentId: 'agent-a', actionId: 'list_issues', allowed: false}],
		});

		expect(moved).toEqual({defaults: [], grants: []});
	});

	test('a tool the server never listed counts for nothing', () => {
		const moved = movedPermissions(EXA_MCP, ['search', 'fetch'], {listed: ['web_search_exa', 'web_fetch_exa'], defaults: ['web_search_exa', 'web_fetch_exa'], grants: []});

		expect(moved.defaults).toEqual(['search', 'fetch']);
	});

	test("Cloudflare's execute ran any code, so it is every action at once; search and docs reached nothing of the account and count for nothing", () => {
		const listed = ['search', 'execute', 'docs', 'whoami'];
		const actions = ['read', 'write', 'delete'];

		expect(movedPermissions(CLOUDFLARE_MCP, actions, {listed, defaults: ['execute'], grants: []}).defaults).toEqual(actions);
		expect(movedPermissions(CLOUDFLARE_MCP, actions, {listed, defaults: ['search', 'docs'], grants: []}).defaults).toEqual([]);
	});
});

describe('movedRun', () => {
	test("becomes the integration's request, titled from the params kept", () => {
		expect(movedRun(EXA_MCP, {id: 'e-1', action: 'web_search_exa', query: JSON.stringify({query: 'bun mocks', objective: 'bun mocks'})})).toEqual({
			id: 'e-1',
			collectionId: 'searches',
			action: 'run',
			recordTitle: 'bun mocks',
			query: null,
		});
		expect(movedRun(PARALLEL_MCP, {id: 'e-2', action: 'web_fetch', query: JSON.stringify({urls: ['https://example.com', 'https://example.org']})})).toMatchObject({
			collectionId: 'pages',
			action: 'read',
			recordTitle: 'https://example.com',
		});
		expect(movedRun(LINEAR_MCP, {id: 'e-3', action: 'list_issues', query: JSON.stringify({query: 'login'})})).toMatchObject({
			collectionId: 'issues',
			action: 'list',
			recordTitle: null,
			query: 'login',
		});
	});

	test('one tool can become different requests by its params, as saving a Linear issue creates or edits', () => {
		expect(movedRun(LINEAR_MCP, {id: 'e-1', action: 'save_issue', query: JSON.stringify({id: 'ENG-1', title: 'Fix it'})})).toMatchObject({action: 'update', recordTitle: 'ENG-1'});
		expect(movedRun(LINEAR_MCP, {id: 'e-2', action: 'save_issue', query: JSON.stringify({team: 'ENG', title: 'Fix it'})})).toMatchObject({action: 'create', recordTitle: 'Fix it'});
	});

	test('params cut short, or none, leave it without a title; a tool the integration has nothing for stays a tool run', () => {
		expect(movedRun(EXA_MCP, {id: 'e-1', action: 'web_search_exa', query: '{"query":"a very long que…'})).toMatchObject({collectionId: 'searches', recordTitle: null});
		expect(movedRun(EXA_MCP, {id: 'e-2', action: 'web_search_exa', query: null})).toMatchObject({collectionId: 'searches', recordTitle: null});
		expect(movedRun(EXA_MCP, {id: 'e-3', action: 'agent_run', query: null})).toBeNull();
	});
});

describe('movedCredential', () => {
	test("keeps a sign-in to the integration's own server, whatever the query of the address", () => {
		expect(movedCredential(EXA_MCP, {...EXA_SIGN_IN, url: 'https://mcp.exa.ai/mcp?tools=web_search_exa'})).toEqual({
			kind: 'moved',
			credential: {clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null},
		});
	});

	test("a token typed in becomes the integration's API key, where it takes one and the token is a bare one", () => {
		expect(movedCredential(EXA_MCP, {auth: 'token', url: 'https://mcp.exa.ai/mcp', token: 'key-1'})).toEqual({kind: 'moved', credential: {auth: 'key', key: 'key-1'}});
		expect(movedCredential(PARALLEL_MCP, {auth: 'token', url: 'https://search.parallel.ai/mcp', token: 'pk_1'})).toEqual({kind: 'moved', credential: {auth: 'key', key: 'pk_1'}});
		expect(movedCredential(LINEAR_MCP, {auth: 'token', url: 'https://mcp.linear.app/mcp', token: 'lin_api_1'})).toEqual({kind: 'moved', credential: {auth: 'key', key: 'lin_api_1'}});
		expect(movedCredential(EXA_MCP, {auth: 'token', url: 'https://mcp.exa.ai/mcp', token: 'Basic abc'})).toEqual({kind: 'moved', credential: null});
	});

	test("a key in the address, as Exa's own setup writes it, becomes the integration's API key", () => {
		expect(movedCredential(EXA_MCP, {auth: 'none', url: 'https://mcp.exa.ai/mcp?exaApiKey=key-2'})).toEqual({kind: 'moved', credential: {auth: 'key', key: 'key-2'}});
	});

	test('a server reached with nothing at all stays custom, rather than stop working', () => {
		expect(movedCredential(PARALLEL_MCP, {auth: 'none', url: 'https://search.parallel.ai/mcp'})).toEqual({kind: 'stays'});
		expect(movedCredential(EXA_MCP, {auth: 'none', url: 'https://mcp.exa.ai/mcp'})).toEqual({kind: 'stays'});
	});

	test('a sign-in through another authorization server has to be signed in to again', () => {
		expect(movedCredential(EXA_MCP, {...EXA_SIGN_IN, server: {...EXA_SIGN_IN.server, tokenUrl: 'https://elsewhere.example.com/token'}})).toEqual({kind: 'moved', credential: null});
		expect(movedCredential(LINEAR_MCP, {...EXA_SIGN_IN, url: 'https://mcp.linear.app/sse'})).toEqual({kind: 'moved', credential: null});
	});
});

function customRow(id: string, account: string, credential: object, tools: string[], defaults: string[]) {
	return {
		id,
		account,
		credential: stored(credential),
		tools: JSON.stringify(tools.map((name) => ({name, inputSchema: {type: 'object'}}))),
		defaults: defaults.map((actionId) => ({actionId})),
		agentGrants: [],
	};
}

type Row = ReturnType<typeof customRow>;
type Run = {id: string; action: string; query: string | null};
type Move = (connection: Row & {runs: Run[]}, keepCredential: (credential: string) => Promise<Result<void, ApiError>>) => Promise<Result<object | null, ApiError>>;

// The custom connections, as the lock reads them, their tool runs in the activity log, what each
// moved became, as `takeOverConnection` was told with it locked, and the credentials kept on the way.
let rows: Row[] = [];
let runs: Record<string, Run[]> = {};
let moves: Array<{connectionId: string} & Record<string, string | null | object>> = [];
let kept: Array<{connectionId: string; credential: string}> = [];

function listed(...listedRows: Row[]) {
	rows = listedRows;
	listCustomMcpConnections.mockResolvedValue(Ok(listedRows.map(({id, account}) => ({id, account}))));
}

beforeEach(() => {
	mock.clearAllMocks();
	rows = [];
	runs = {};
	moves = [];
	kept = [];
	tokenRequests.length = 0;
	takeOverConnection.mockImplementation(async (connectionId: string, collectionId: string, move: Move) => {
		const row = rows.find((candidate) => candidate.id === connectionId);
		if (!row || collectionId !== 'tools') {
			return Ok(false);
		}
		const moved = await move({...row, runs: runs[connectionId] ?? []}, async (credential) => {
			kept.push({connectionId, credential});
			return Ok(undefined);
		});
		if (moved.isErr()) {
			return moved;
		}
		if (moved.value === null) {
			return Ok(false);
		}
		moves.push({connectionId, ...moved.value});
		return Ok(true);
	});
});

describe('takeOverCustomConnections', () => {
	test('moves each custom connection to a server an integration takes over, and leaves the rest', async () => {
		listed(
			customRow('mcp-exa', 'mcp.exa.ai/mcp', EXA_SIGN_IN, ['web_search_exa', 'web_fetch_exa', 'agent_run'], ['web_search_exa', 'agent_run']),
			customRow('mcp-parallel', 'search.parallel.ai/mcp', {auth: 'token', url: 'https://search.parallel.ai/mcp', token: 'pk_5678'}, ['web_search', 'web_fetch'], ['web_search', 'web_fetch']),
			customRow('mcp-keyless', 'search.parallel.ai/mcp', {auth: 'none', url: 'https://search.parallel.ai/mcp'}, ['web_search'], ['web_search']),
			customRow('mcp-docs', 'mcp.example.com/mcp', {auth: 'none', url: 'https://mcp.example.com/mcp'}, ['web_search'], ['web_search']),
		);
		runs['mcp-exa'] = [
			{id: 'e-1', action: 'web_search_exa', query: JSON.stringify({query: 'bun mocks'})},
			{id: 'e-2', action: 'agent_run', query: null},
		];

		expect((await takeOverCustomConnections()).isOk()).toBe(true);

		// Whether a keyless server's connection stays custom is told from its credential as locked.
		expect(takeOverConnection.mock.calls.map((call) => call[0])).toEqual(['mcp-exa', 'mcp-parallel', 'mcp-keyless']);
		expect(moves).toEqual([
			{
				connectionId: 'mcp-exa',
				integrationId: 'exa',
				account: 'Signed in',
				credential: stored({clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null}),
				defaults: ['search'],
				grants: [],
				runs: [{id: 'e-1', collectionId: 'searches', action: 'run', recordTitle: 'bun mocks', query: null}],
			},
			{
				connectionId: 'mcp-parallel',
				integrationId: 'parallel',
				account: 'API key ending 5678',
				credential: stored({auth: 'key', key: 'pk_5678'}),
				defaults: ['search', 'fetch'],
				grants: [],
				runs: [],
			},
		]);
		// Exa says nothing of who signed in, so its tokens aren't refreshed to ask.
		expect(tokenRequests).toEqual([]);
	});

	const NOTION_SIGN_IN = {...EXA_SIGN_IN, url: 'https://mcp.notion.com/mcp', server: {...EXA_SIGN_IN.server, url: 'https://mcp.notion.com/mcp', tokenUrl: 'https://mcp.notion.com/token'}};
	const EXPIRED = '2026-01-01T00:00:00.000Z';
	const read = (credential: string | null | object | undefined) => JSON.parse(String(credential).replace(/^enc:/, ''));

	test('a sign-in still good is asked for its account as it is, workspace and all', async () => {
		listed(customRow('mcp-notion', 'mcp.notion.com/mcp', NOTION_SIGN_IN, ['notion-search'], ['notion-search']));

		await takeOverCustomConnections();

		expect(tokenRequests).toEqual([]);
		expect(moves[0]).toMatchObject({connectionId: 'mcp-notion', integrationId: 'notion', account: 'alex@example.com · Acme', defaults: ['read']});
		expect(read(moves[0]?.credential)).toMatchObject({accessToken: 'access-1', refreshToken: 'refresh-1'});
	});

	test('a sign-in that ran out, or was turned down before its time, is refreshed first, and the new tokens kept at once', async () => {
		listed(
			customRow('mcp-expired', 'mcp.notion.com/mcp', {...NOTION_SIGN_IN, expiresAt: EXPIRED}, ['notion-search'], []),
			customRow('mcp-stale', 'mcp.notion.com/mcp', {...NOTION_SIGN_IN, accessToken: 'stale-1'}, ['notion-search'], []),
		);

		await takeOverCustomConnections();

		expect(tokenRequests).toEqual(['https://mcp.notion.com/token', 'https://mcp.notion.com/token']);
		expect(moves.map((move) => [move.connectionId, move.account, read(move.credential).refreshToken])).toEqual([
			['mcp-expired', 'alex@example.com · Acme', 'refresh-2'],
			['mcp-stale', 'alex@example.com · Acme', 'refresh-2'],
		]);
		// Kept on the custom connection as it was, its server's endpoints and all.
		expect(kept.map((keep) => keep.connectionId)).toEqual(['mcp-expired', 'mcp-stale']);
		expect(read(kept[0]?.credential)).toMatchObject({auth: 'oauth', url: 'https://mcp.notion.com/mcp', accessToken: 'access-2', refreshToken: 'refresh-2'});
	});

	test('a sign-in Notion revoked carries nothing over: it waits to be signed in to', async () => {
		listed(customRow('mcp-revoked', 'mcp.notion.com/mcp', {...NOTION_SIGN_IN, expiresAt: EXPIRED, refreshToken: 'revoked'}, ['notion-search'], []));

		await takeOverCustomConnections();

		expect(moves[0]).toMatchObject({connectionId: 'mcp-revoked', integrationId: 'notion', account: 'mcp.notion.com/mcp', credential: null});
		expect(kept).toEqual([]);
	});

	test('Notion out of reach after a refresh leaves the connection to the next start, the new refresh token kept', async () => {
		listed(customRow('mcp-notion', 'mcp.notion.com/mcp', {...NOTION_SIGN_IN, expiresAt: EXPIRED, refreshToken: 'refresh-down'}, ['notion-search'], []));

		// Left unrecorded, so the data migration is tried again on the next start.
		expect((await takeOverCustomConnections()).isErr()).toBe(true);

		expect(moves).toEqual([]);
		expect(read(kept[0]?.credential)).toMatchObject({auth: 'oauth', accessToken: 'down-2', refreshToken: 'refresh-3'});
	});

	test("a credential that can't be read stays custom, and doesn't hold the migration open for the next start", async () => {
		listed({...customRow('mcp-linear', 'mcp.linear.app/mcp', {}, ['list_issues'], []), credential: 'enc:not json'});

		// Nothing the next start could do differently, so the data migration is noted as done.
		expect((await takeOverCustomConnections()).isOk()).toBe(true);

		expect(takeOverConnection).toHaveBeenCalledTimes(1);
		expect(moves).toEqual([]);
	});

	test('a key is checked with the server, as connecting with one is: a token it turns down carries nothing over', async () => {
		listed(
			customRow('mcp-exa', 'mcp.exa.ai/mcp', {auth: 'token', url: 'https://mcp.exa.ai/mcp', token: 'bad-1234'}, ['web_search_exa'], ['web_search_exa']),
			customRow('mcp-linear', 'mcp.linear.app/mcp', {auth: 'token', url: 'https://mcp.linear.app/mcp', token: 'bad-5678'}, ['list_issues'], ['list_issues']),
		);

		await takeOverCustomConnections();

		expect(moves.map((move) => [move.connectionId, move.integrationId, move.account, move.credential])).toEqual([
			['mcp-exa', 'exa', 'mcp.exa.ai/mcp', null],
			['mcp-linear', 'linear', 'mcp.linear.app/mcp', null],
		]);
	});

	test('a connection another server moved first is left to it, and the rest still move', async () => {
		listed(
			customRow('mcp-exa', 'mcp.exa.ai/mcp', EXA_SIGN_IN, ['web_search_exa'], []),
			customRow('mcp-linear', 'mcp.linear.app/mcp', {auth: 'token', url: 'https://mcp.linear.app/mcp', token: 'lin_api_1'}, ['list_issues', 'get_issue'], ['list_issues', 'get_issue']),
		);
		takeOverConnection.mockImplementationOnce(async () => Ok(false));

		await takeOverCustomConnections();

		expect(takeOverConnection).toHaveBeenCalledTimes(2);
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({
			connectionId: 'mcp-linear',
			integrationId: 'linear',
			account: 'alex@example.com · Acme',
			credential: stored({auth: 'key', key: 'lin_api_1'}),
			defaults: ['read'],
		});
	});
});
