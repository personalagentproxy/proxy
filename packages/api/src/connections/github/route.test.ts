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

const env: {NODE_ENV: string; APP_URL: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string} = {
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

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	if (url.pathname === '/login/oauth/access_token') {
		return Response.json({access_token: 'ghu_access1', expires_in: 28800, refresh_token: 'ghr_refresh1', token_type: 'bearer', scope: ''});
	}
	if (url.pathname === '/user/emails') {
		return Response.json([{email: 'alex@example.com', primary: true, verified: true}]);
	}
	if (url.pathname === '/user') {
		return Response.json({login: 'alexkim', id: 4242, name: 'Alex Kim', email: null});
	}
	return new Response('Not found', {status: 404});
}) as typeof fetch);

const {handleGitHubCallbackRoute, handleStartGitHubRoute} = await import('./route');

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
	env.GITHUB_CLIENT_ID = 'Iv23client';
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

	test('without the client on the server, goes back to the catalog saying so', async () => {
		env.GITHUB_CLIENT_ID = undefined;
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
			email: 'alex@example.com',
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
