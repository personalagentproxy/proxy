import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const createConnection = mock();
const renewConnection = mock();
const getConnectionWithCredential = mock();

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({
	markCredentialRejected,
	getConnectionWithCredential,
	findAccountConnection,
	createConnection,
	renewConnection,
	setConnectionSharing: mock(),
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

const env: {NODE_ENV: string; APP_URL: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; GITHUB_APP_SLUG?: string} = {
	NODE_ENV: 'production',
	APP_URL: 'https://app.example.com',
	GITHUB_CLIENT_ID: 'Iv23client',
	GITHUB_CLIENT_SECRET: 'secret-1',
};

mock.module('../../utils/env', () => ({env}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const CALLBACK = 'https://app.example.com/api/connections/github/callback';

// GitHub's API for the installations route: what the person's installations are, and what each lists.
const github = {installations: [] as object[], pages: {} as Record<string, {total: number; repositories: object[]}>};

function installation(id: number, login: string, type: 'User' | 'Organization', selection: 'all' | 'selected'): object {
	return {id, account: {login, type}, repository_selection: selection, html_url: `https://github.com/settings/installations/${id}`};
}

function repository(fullName: string, isPrivate = false): object {
	return {
		full_name: fullName,
		description: null,
		private: isPrivate,
		default_branch: 'main',
		language: null,
		html_url: `https://github.com/${fullName}`,
		pushed_at: '2026-11-01T10:00:00Z',
		updated_at: null,
	};
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	if (url.pathname === '/user/installations') {
		return Response.json({total_count: github.installations.length, installations: github.installations});
	}
	const listed = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
	if (listed) {
		const page = github.pages[`${listed[1]}:${url.searchParams.get('page')}`] ?? {total: 0, repositories: []};
		return Response.json({total_count: page.total, repositories: page.repositories});
	}
	if (url.pathname === '/login/oauth/access_token') {
		return Response.json({access_token: 'ghu_access1', expires_in: 28800, refresh_token: 'ghr_refresh1', token_type: 'bearer', scope: ''});
	}
	if (url.pathname === '/user') {
		return Response.json({login: 'alexkim', id: 4242, name: 'Alex Kim', email: null});
	}
	return new Response('Not found', {status: 404});
}) as typeof fetch);

const {handleGitHubCallbackRoute, handleGitHubInstallationsRoute, handleStartGitHubRoute} = await import('./route');

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
	const res = makeRes();
	await handleStartGitHubRoute({user, params: {org: 'org-1'}, query, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.github-state');
	const redirected = res.redirect.mock.calls[0]?.[0] as string;
	return {cookie, redirected, state: URL.canParse(redirected) ? (new URL(redirected).searchParams.get('state') ?? '') : ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const res = makeRes();
	await handleGitHubCallbackRoute({user, params: {org: 'org-1'}, query: args.query, headers: {cookie: `proxy.github-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	env.GITHUB_APP_SLUG = 'personal-agent-proxy';
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockResolvedValue(Ok({id: 'conn-1', ownerUserId: 'user-1', sharedWithEveryone: false, shares: []}));
	renewConnection.mockResolvedValue(Ok(undefined));
});

describe('handleStartGitHubRoute', () => {
	test("sends the browser to GitHub's sign-in with the app's client and the callback, keeping the handshake in a cookie", async () => {
		const {cookie, redirected} = await start({account: 'alexkim'});

		const url = new URL(redirected);
		expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(url.searchParams.get('client_id')).toBe('Iv23client');
		expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
		expect(url.searchParams.get('login')).toBe('alexkim');
		expect(cookie?.options).toMatchObject({httpOnly: true, path: '/api/connections/github'});
	});

	test('without the client on the server, or the app’s name, goes back to the catalog saying so', async () => {
		env.GITHUB_APP_SLUG = undefined;
		const {redirected} = await start();

		expect(redirected).toBe('https://app.example.com/org-1/connections/new?error=github-unconfigured');
	});
});

describe('handleGitHubCallbackRoute', () => {
	test('makes the connection for the login signed in with, found by GitHub’s id, agents reading repositories', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(findAccountConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), {integrationId: 'github', account: 'alexkim', providerAccountId: '4242'});
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'github', account: 'alexkim', providerAccountId: '4242', defaults: ['read']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toMatchObject({
			accessToken: 'ghu_access1',
			refreshToken: 'ghr_refresh1',
			login: 'alexkim',
			name: 'Alex Kim',
		});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-1?added');
	});

	test('signing in to the same account again gives its connection the new tokens', async () => {
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0', ownerUserId: 'user-1', sharedWithEveryone: false, shares: []}));
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0', account: 'alexkim', providerAccountId: '4242'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-0');
	});

	test('a sign-in turned down at GitHub goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/new?error=github');
		expect(createConnection).not.toHaveBeenCalled();
	});
});

describe('handleGitHubInstallationsRoute', () => {
	const CREDENTIAL = {
		accessToken: 'ghu_access1',
		refreshToken: 'ghr_1',
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		id: '4242',
		login: 'alexkim',
		name: 'Alex Kim',
	};

	function connection(integrationId = 'github'): object {
		return {
			id: 'conn-1',
			orgId: 'org-1',
			integrationId,
			account: 'alexkim',
			ownerUserId: 'user-1',
			sharedWithEveryone: false,
			shares: [],
			createdAt: new Date(),
			tools: null,
			name: null,
			defaults: [],
			credential: `enc:${JSON.stringify(CREDENTIAL)}`,
		};
	}

	const request = {user, params: {org: 'org-1', connectionId: 'conn-1'}} as never;

	beforeEach(() => {
		getConnectionWithCredential.mockResolvedValue(Ok(connection()));
		github.installations = [installation(11, 'acme', 'Organization', 'all'), installation(22, 'alexkim', 'User', 'selected')];
		github.pages = {
			'11:1': {total: 2, repositories: [repository('acme/api'), repository('acme/web', true)]},
			'22:1': {total: 1, repositories: [repository('alexkim/notes', true)]},
		};
	});

	test('lists each installation the person can see with what it covers and its repositories, and where to install the app on another', async () => {
		const reach = (await handleGitHubInstallationsRoute(request)).unwrap();

		expect(reach.installations).toEqual([
			{
				account: 'acme',
				accountType: 'Organization',
				all: true,
				settingsUrl: 'https://github.com/settings/installations/11',
				repositories: [
					{fullName: 'acme/api', visibility: 'Public', pushedAt: '2026-11-01T10:00:00Z', url: 'https://github.com/acme/api'},
					{fullName: 'acme/web', visibility: 'Private', pushedAt: '2026-11-01T10:00:00Z', url: 'https://github.com/acme/web'},
				],
				more: false,
			},
			expect.objectContaining({account: 'alexkim', accountType: 'User', all: false, repositories: [expect.objectContaining({fullName: 'alexkim/notes'})]}),
		]);
		expect(reach.installUrl).toBe('https://github.com/apps/personal-agent-proxy/installations/new');
	});

	test('with no installation, lists none and still says where to install the app', async () => {
		github.installations = [];
		expect((await handleGitHubInstallationsRoute(request)).unwrap()).toEqual({installations: [], installUrl: 'https://github.com/apps/personal-agent-proxy/installations/new'});
	});

	test('says there are more where GitHub listed more than the pages it reads', async () => {
		github.installations = [installation(11, 'acme', 'Organization', 'all')];
		github.pages = {
			'11:1': {total: 301, repositories: Array.from({length: 100}, (_, i) => repository(`acme/a-${i}`))},
			'11:2': {total: 301, repositories: Array.from({length: 100}, (_, i) => repository(`acme/b-${i}`))},
			'11:3': {total: 301, repositories: Array.from({length: 100}, (_, i) => repository(`acme/c-${i}`))},
		};
		const [acme] = (await handleGitHubInstallationsRoute(request)).unwrap().installations;

		expect(acme?.repositories.length).toBe(300);
		expect(acme?.more).toBe(true);
	});

	test('a connection of another integration is not found', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(connection('notion')));
		expect((await handleGitHubInstallationsRoute(request)).unwrapErr().kind).toBe('not_found');
	});
});
