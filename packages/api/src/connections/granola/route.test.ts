import {createHash} from 'node:crypto';

import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const listConnections = mock();
const createConnection = mock();
const updateConnectionCredential = mock();

mock.module('@proxy/db/connection', () => ({listConnections, createConnection, updateConnectionCredential}));

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

const CALLBACK = 'https://app.example.com/api/connections/granola/callback';

// Granola's authorization server: each request, and its answers.
const granola = {requests: [] as Array<{url: URL; body: string}>, userinfo: {sub: 'user-1', email: 'Alex@Example.com'} as object};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	granola.requests.push({url, body: typeof init?.body === 'string' ? init.body : ''});
	if (url.pathname === '/oauth2/register') {
		return Response.json({client_id: 'client-1'}, {status: 201});
	}
	if (url.pathname === '/oauth2/token') {
		return Response.json({access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600});
	}
	return Response.json(granola.userinfo);
}) as typeof fetch);

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

// The start route for a real state cookie and Granola sign-in address.
async function start() {
	const {handleStartGranolaRoute} = await import('./route');
	const res = makeRes();
	await handleStartGranolaRoute({user, query: {}, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.granola-state');
	const authorizeUrl = new URL(res.redirect.mock.calls[0]?.[0] as string);
	return {res, cookie, authorizeUrl, state: authorizeUrl.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>; userId?: string}) {
	const {handleGranolaCallbackRoute} = await import('./route');
	const res = makeRes();
	await handleGranolaCallbackRoute({user: {...user, userId: args.userId ?? user.userId}, query: args.query, headers: {cookie: `proxy.granola-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	granola.requests = [];
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockResolvedValue(Ok({id: 'conn-1'}));
	updateConnectionCredential.mockResolvedValue(Ok(true));
});

describe('handleStartGranolaRoute', () => {
	test('registers with Granola and sends the browser to its sign-in with PKCE, for the MCP server', async () => {
		const {res, cookie, authorizeUrl} = await start();

		expect(JSON.parse(granola.requests[0]?.body ?? '{}')).toMatchObject({redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token']});
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://mcp-auth.granola.ai/oauth2/authorize');
		expect(authorizeUrl.searchParams.get('client_id')).toBe('client-1');
		expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(CALLBACK);
		expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizeUrl.searchParams.get('resource')).toBe('https://mcp.granola.ai/mcp');
		expect(authorizeUrl.searchParams.get('scope')).toContain('offline_access');
		expect(cookie?.options).toMatchObject({httpOnly: true, sameSite: 'lax', path: '/api/connections/granola'});
		expect(res.redirect).toHaveBeenCalledTimes(1);
	});
});

describe('handleGranolaCallbackRoute', () => {
	test('trades the code with the PKCE verifier and makes the connection, notes and transcripts on', async () => {
		const {cookie, authorizeUrl, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		const token = new URLSearchParams(granola.requests.find((request) => request.url.pathname === '/oauth2/token')?.body);
		expect(token.get('code')).toBe('code-1');
		expect(
			createHash('sha256')
				.update(token.get('code_verifier') ?? '')
				.digest('base64url'),
		).toBe(authorizeUrl.searchParams.get('code_challenge') ?? '');
		const created = createConnection.mock.calls[0]?.[0];
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'granola', account: 'alex@example.com', defaults: ['readNotes', 'readTranscripts']});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toMatchObject({clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1'});
		expect(res.clearCookie).toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-1?added');
	});

	test('signing in to an account already connected gives that connection the new tokens', async () => {
		listConnections.mockResolvedValue(Ok([{id: 'conn-old', integrationId: 'granola', account: 'alex@example.com'}]));
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection).not.toHaveBeenCalled();
		expect(updateConnectionCredential.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-old'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/conn-old?added');
	});

	test('a state that does not match, or another user, connects nothing', async () => {
		const {cookie, state} = await start();
		const forged = await callback({cookie: cookie?.value ?? '', query: {state: 'forged', code: 'code-1'}});
		const otherUser = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}, userId: 'user-2'});

		expect(forged.redirect).toHaveBeenCalledWith('https://app.example.com/connections/new?error=granola');
		expect(otherUser.redirect).toHaveBeenCalledWith('https://app.example.com/connections/new?error=granola');
		expect(granola.requests.some((request) => request.url.pathname === '/oauth2/token')).toBe(false);
		expect(createConnection).not.toHaveBeenCalled();
	});

	test('a sign-in turned down at Granola goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/connections/new?error=granola');
		expect(createConnection).not.toHaveBeenCalled();
	});
});
