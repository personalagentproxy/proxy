import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../../utils/env', () => ({
	env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GITHUB_CLIENT_ID: 'Iv23client', GITHUB_CLIENT_SECRET: 'secret-1', GITHUB_APP_SLUG: 'personal-agent-proxy'},
}));

mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const {exchangeGitHubCode, githubAuthorizeUrl, isExpiring, readGitHubCredential, refreshGitHubTokens, revokeGitHubGrant} = await import('./github-oauth');

const CLIENT = {clientId: 'Iv23client', clientSecret: 'secret-1', slug: 'personal-agent-proxy'};

type Seen = {url: URL; method: string; headers: Headers; body: string};

// GitHub's token endpoint and API: each request, and what each answers.
const github = {requests: [] as Seen[], token: {} as object, user: {} as object};

function seenPaths(): string[] {
	return github.requests.map((request) => `${request.method} ${request.url.host}${request.url.pathname}`);
}

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	github.requests.push({url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : ''});
	if (url.pathname === '/login/oauth/access_token') {
		return Response.json(github.token);
	}
	if (url.pathname === '/user') {
		return Response.json(github.user);
	}
	if (url.pathname.endsWith('/grant') && init?.method === 'DELETE') {
		return new Response(null, {status: 204});
	}
	return new Response('Not found', {status: 404});
}) as typeof fetch);

afterEach(() => {
	fetchSpy.mockClear();
});

beforeEach(() => {
	github.requests = [];
	github.token = {access_token: 'ghu_access1', expires_in: 28800, refresh_token: 'ghr_refresh1', refresh_token_expires_in: 15897600, token_type: 'bearer', scope: ''};
	github.user = {login: 'alexkim', id: 4242, name: 'Alex Kim', email: null};
});

describe('githubAuthorizeUrl', () => {
	test("sends the browser to GitHub's sign-in with the client, the callback and the state, and the login to open on where one is given", () => {
		const url = new URL(githubAuthorizeUrl(CLIENT, {redirectUri: 'https://app.example.com/api/connections/github/callback', state: 'state-1', account: 'alexkim'}));

		expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(Object.fromEntries(url.searchParams)).toEqual({client_id: 'Iv23client', redirect_uri: 'https://app.example.com/api/connections/github/callback', state: 'state-1', login: 'alexkim'});
		expect(new URL(githubAuthorizeUrl(CLIENT, {redirectUri: 'https://x', state: 's', account: null})).searchParams.has('login')).toBe(false);
	});
});

describe('exchangeGitHubCode', () => {
	test('trades the code with the client secret, then reads who it is for', async () => {
		const {account, credential} = (await exchangeGitHubCode(CLIENT, {redirectUri: 'https://app.example.com/api/connections/github/callback', code: 'code-1'})).unwrap();

		expect(seenPaths()).toEqual(['POST github.com/login/oauth/access_token', 'GET api.github.com/user']);
		const token = github.requests[0];
		expect(token?.headers.get('accept')).toBe('application/json');
		expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({
			code: 'code-1',
			redirect_uri: 'https://app.example.com/api/connections/github/callback',
			client_id: 'Iv23client',
			client_secret: 'secret-1',
		});
		expect(github.requests[1]?.headers.get('authorization')).toBe('Bearer ghu_access1');
		expect(github.requests[1]?.headers.get('user-agent')).toBe('Personal Agent Proxy');
		expect(account).toEqual({id: '4242', login: 'alexkim', name: 'Alex Kim'});
		expect(credential).toMatchObject({accessToken: 'ghu_access1', refreshToken: 'ghr_refresh1', id: '4242', login: 'alexkim', name: 'Alex Kim'});
		expect(Date.parse(credential.expiresAt ?? '') - Date.now()).toBeGreaterThan(28_000_000);
	});

	test('a token that never expires, as an app without expiring tokens hands out, has no expiry', async () => {
		github.token = {access_token: 'ghu_access1', token_type: 'bearer', scope: ''};
		const {credential} = (await exchangeGitHubCode(CLIENT, {redirectUri: 'https://x', code: 'code-1'})).unwrap();

		expect(credential).toMatchObject({refreshToken: null, expiresAt: null});
		expect(isExpiring(credential)).toBe(false);
	});

	test('a code GitHub turns down, which it does with a 200, is the sign-in rejected; anything else GitHub says is GitHub out of reach', async () => {
		github.token = {error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.'};
		expect((await exchangeGitHubCode(CLIENT, {redirectUri: 'https://x', code: 'spent'})).unwrapErr().kind).toBe('credentials_rejected');

		github.token = {error: 'something_else'};
		expect((await exchangeGitHubCode(CLIENT, {redirectUri: 'https://x', code: 'code-1'})).unwrapErr().kind).toBe('provider_unreachable');
	});
});

describe('refreshGitHubTokens', () => {
	const credential = {accessToken: 'ghu_old', refreshToken: 'ghr_old', expiresAt: new Date(Date.now() - 1000).toISOString(), id: '4242', login: 'alexkim', name: 'Alex Kim'};

	test('takes new tokens for the refresh token, the new refresh token among them, and keeps the account', async () => {
		github.token = {access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new', token_type: 'bearer'};
		const refreshed = (await refreshGitHubTokens(CLIENT, credential)).unwrap();

		expect(Object.fromEntries(new URLSearchParams(github.requests[0]?.body))).toEqual({grant_type: 'refresh_token', refresh_token: 'ghr_old', client_id: 'Iv23client', client_secret: 'secret-1'});
		expect(refreshed).toMatchObject({accessToken: 'ghu_new', refreshToken: 'ghr_new', login: 'alexkim'});
		expect(isExpiring(credential)).toBe(true);
		expect(isExpiring(refreshed)).toBe(false);
	});

	test('a refresh token GitHub won’t take, or none, is the sign-in to be done again', async () => {
		github.token = {error: 'bad_refresh_token'};
		expect((await refreshGitHubTokens(CLIENT, credential)).unwrapErr().kind).toBe('credentials_rejected');
		expect((await refreshGitHubTokens(CLIENT, {...credential, refreshToken: null})).unwrapErr().kind).toBe('credentials_rejected');
	});
});

describe('revokeGitHubGrant', () => {
	test("ends the person's authorization of the app, speaking as the app", async () => {
		const credential = {accessToken: 'ghu_access1', refreshToken: null, expiresAt: null, id: '4242', login: 'alexkim', name: null};
		(await revokeGitHubGrant(CLIENT, credential)).unwrap();

		const request = github.requests[0];
		expect(`${request?.method} ${request?.url.pathname}`).toBe('DELETE /applications/Iv23client/grant');
		expect(request?.headers.get('authorization')).toBe(`Basic ${Buffer.from('Iv23client:secret-1').toString('base64')}`);
		expect(JSON.parse(request?.body ?? '{}')).toEqual({access_token: 'ghu_access1'});
	});
});

describe('readGitHubCredential', () => {
	test('reads what a connection stores, and refuses what isn’t one', () => {
		const credential = {accessToken: 'ghu_access1', refreshToken: 'ghr_1', expiresAt: null, id: '4242', login: 'alexkim', name: null};
		expect(readGitHubCredential(`enc:${JSON.stringify(credential)}`).unwrap()).toEqual(credential);
		expect(readGitHubCredential(null).unwrapErr().kind).toBe('internal_error');
		expect(readGitHubCredential('enc:{"nope":true}').unwrapErr().kind).toBe('internal_error');
	});
});
