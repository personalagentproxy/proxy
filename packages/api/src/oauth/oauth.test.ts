import {createHash} from 'node:crypto';

import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const getOAuthClient = mock();
const createOAuthClient = mock();
const deleteStaleOAuthClients = mock();
const createOAuthCode = mock();
const takeOAuthCode = mock();
const createOAuthGrant = mock();
const getOAuthGrantByRefreshToken = mock();
const rotateOAuthGrant = mock();

mock.module('@proxy/db/oauth', () => ({getOAuthClient, createOAuthClient, deleteStaleOAuthClients, createOAuthCode, takeOAuthCode, createOAuthGrant, getOAuthGrantByRefreshToken, rotateOAuthGrant}));

const getAgent = mock();

mock.module('@proxy/db/agent', () => ({getAgent}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

const createAgentLogin = mock();

mock.module('../agents/create-agent-login', () => ({createAgentLogin}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

// Readable stand-ins for encryption, so a test can read and forge a sealed request.
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => (stored.startsWith('enc:') ? Ok(stored.slice(4)) : Err(ApiErr.internalError(new Error('Unreadable secret')))),
}));

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const publicClient = {id: 'client-1', name: 'Claude', redirectUris: [REDIRECT], secretHash: null};

function sha256(value: string, encoding: 'hex' | 'base64url' = 'hex'): string {
	return createHash('sha256').update(value).digest(encoding);
}

function makeRes() {
	const res = {
		statusCode: 200,
		body: undefined as unknown,
		headers: {} as Record<string, string>,
		redirectedTo: null as string | null,
		status: mock((code: number) => {
			res.statusCode = code;
			return res;
		}),
		setHeader: mock((name: string, value: string) => {
			res.headers[name.toLowerCase()] = value;
			return res;
		}),
		type: mock(() => res),
		send: mock((body: unknown) => {
			res.body = body;
			return res;
		}),
		json: mock((body: unknown) => {
			res.body = body;
			return res;
		}),
		redirect: mock((to: string) => {
			res.redirectedTo = to;
		}),
	};
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	getOAuthClient.mockResolvedValue(Ok(publicClient));
	createOAuthClient.mockImplementation(async (data: unknown) => Ok(data));
	deleteStaleOAuthClients.mockResolvedValue(Ok(0));
	createOAuthCode.mockResolvedValue(Ok(undefined));
	createOAuthGrant.mockResolvedValue(Ok(undefined));
	rotateOAuthGrant.mockResolvedValue(Ok(true));
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	getAgent.mockResolvedValue(Ok({id: 'agent-1', name: 'Dot', revokedAt: null}));
});

describe('isAllowedRedirectUri', () => {
	test('HTTPS, loopback HTTP and an app’s own scheme, never a fragment or a script', async () => {
		const {isAllowedRedirectUri} = await import('./oauth-config');
		expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
		expect(isAllowedRedirectUri('http://localhost:33418/callback')).toBe(true);
		expect(isAllowedRedirectUri('http://127.0.0.1:8080/cb')).toBe(true);
		expect(isAllowedRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true);
		expect(isAllowedRedirectUri('http://evil.example.com/cb')).toBe(false);
		expect(isAllowedRedirectUri('https://claude.ai/cb#fragment')).toBe(false);
		expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
		expect(isAllowedRedirectUri('not a url')).toBe(false);
	});
});

describe('handleRegisterClientRoute', () => {
	test('registers a public client, with no secret', async () => {
		const {handleRegisterClientRoute} = await import('./register');
		const res = makeRes();
		await handleRegisterClientRoute({body: {client_name: 'Claude', redirect_uris: [REDIRECT]}} as never, res as never);

		expect(res.statusCode).toBe(201);
		expect(res.body).toMatchObject({client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token']});
		expect(res.body).not.toHaveProperty('client_secret');
		expect(createOAuthClient.mock.calls[0]?.[0]).toMatchObject({name: 'Claude', secretHash: null});
	});

	test('first deletes the clients that registered over a day ago and never finished a sign-in', async () => {
		const {handleRegisterClientRoute} = await import('./register');
		await handleRegisterClientRoute({body: {redirect_uris: [REDIRECT]}} as never, makeRes() as never);
		const before = deleteStaleOAuthClients.mock.calls[0]?.[0] as Date;

		expect(Math.abs(Date.now() - 24 * 60 * 60 * 1000 - before.getTime())).toBeLessThan(5000);
		expect(deleteStaleOAuthClients.mock.invocationCallOrder[0]).toBeLessThan(createOAuthClient.mock.invocationCallOrder[0] ?? 0);
	});

	test('registers even when the cleanup fails', async () => {
		deleteStaleOAuthClients.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));
		const {handleRegisterClientRoute} = await import('./register');
		const res = makeRes();
		await handleRegisterClientRoute({body: {redirect_uris: [REDIRECT]}} as never, res as never);

		expect(res.statusCode).toBe(201);
	});

	test('gives a client that asks for one a secret, keeping only its hash', async () => {
		const {handleRegisterClientRoute} = await import('./register');
		const res = makeRes();
		await handleRegisterClientRoute({body: {redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post'}} as never, res as never);

		const secret = (res.body as {client_secret: string}).client_secret;
		expect(secret).toBeString();
		expect(createOAuthClient.mock.calls[0]?.[0].secretHash).toBe(sha256(secret));
	});

	test('refuses a redirect that is not HTTPS or loopback', async () => {
		const {handleRegisterClientRoute} = await import('./register');
		const res = makeRes();
		await handleRegisterClientRoute({body: {redirect_uris: ['http://evil.example.com/cb']}} as never, res as never);

		expect(res.statusCode).toBe(400);
		expect(res.body).toMatchObject({error: 'invalid_redirect_uri'});
		expect(createOAuthClient).not.toHaveBeenCalled();
	});
});

describe('handleAuthorizeRoute', () => {
	const query = {
		client_id: 'client-1',
		redirect_uri: REDIRECT,
		response_type: 'code',
		state: 'xyz',
		code_challenge: 'challenge',
		code_challenge_method: 'S256',
		resource: 'https://app.example.com/mcp',
	};

	async function authorize(overrides: Record<string, string | undefined>) {
		const {handleAuthorizeRoute} = await import('./authorize');
		const res = makeRes();
		await handleAuthorizeRoute({query: {...query, ...overrides}} as never, res as never);
		return res;
	}

	test('hands a good request over to the consent page, sealed', async () => {
		const res = await authorize({});
		const to = new URL(res.redirectedTo ?? '');

		expect(`${to.origin}${to.pathname}`).toBe('https://app.example.com/connect-agent');
		expect(JSON.parse(to.searchParams.get('request')?.slice(4) ?? '')).toMatchObject({clientId: 'client-1', redirectUri: REDIRECT, state: 'xyz', codeChallenge: 'challenge'});
	});

	test('an unknown client or a redirect it did not register is shown, never redirected to', async () => {
		getOAuthClient.mockResolvedValue(Ok(null));
		const unknown = await authorize({});
		getOAuthClient.mockResolvedValue(Ok(publicClient));
		const elsewhere = await authorize({redirect_uri: 'https://evil.example.com/cb'});

		for (const res of [unknown, elsewhere]) {
			expect(res.statusCode).toBe(400);
			expect(res.redirectedTo).toBeNull();
		}
	});

	test('without PKCE, or for another resource, goes back to the client with the error', async () => {
		const noPkce = new URL((await authorize({code_challenge: undefined})).redirectedTo ?? '');
		const plain = new URL((await authorize({code_challenge_method: 'plain'})).redirectedTo ?? '');
		const elsewhere = new URL((await authorize({resource: 'https://other.example.com/mcp'})).redirectedTo ?? '');

		expect(noPkce.searchParams.get('error')).toBe('invalid_request');
		expect(plain.searchParams.get('error')).toBe('invalid_request');
		expect(elsewhere.searchParams.get('error')).toBe('invalid_target');
		expect(noPkce.searchParams.get('state')).toBe('xyz');
	});
});

describe('handleConsentRoute', () => {
	const user = {userId: 'user-1', email: 'alex@example.com'};

	function sealed(overrides: Record<string, unknown> = {}): string {
		return `enc:${JSON.stringify({clientId: 'client-1', redirectUri: REDIRECT, state: 'xyz', codeChallenge: 'challenge', expiresAt: Date.now() + 60_000, ...overrides})}`;
	}

	async function consent(body: Record<string, unknown>) {
		const {handleConsentRoute} = await import('./authorize');
		return handleConsentRoute({user, body} as never);
	}

	test('allowing it as an agent makes a code for it and goes back to the client', async () => {
		const result = await consent({request: sealed(), allow: true, agentId: 'agent-1'});
		const to = new URL(result.unwrap().redirectTo);
		const code = to.searchParams.get('code') ?? '';

		expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
		expect(to.searchParams.get('state')).toBe('xyz');
		expect(to.searchParams.get('iss')).toBe('https://app.example.com');
		expect(createOAuthCode.mock.calls[0]?.[0]).toMatchObject({codeHash: sha256(code), clientId: 'client-1', agentId: 'agent-1', redirectUri: REDIRECT, codeChallenge: 'challenge'});
	});

	test('can make a new login for a provider to work as', async () => {
		createAgentLogin.mockResolvedValue(Ok({agent: {id: 'agent-new'}, password: 'unused'}));
		await consent({request: sealed(), allow: true, providerId: 'claude'});

		expect(createAgentLogin).toHaveBeenCalledWith('org-1', 'claude');
		expect(createOAuthCode.mock.calls[0]?.[0].agentId).toBe('agent-new');
	});

	test('denying it goes back with access_denied and makes no code', async () => {
		const result = await consent({request: sealed(), allow: false});

		expect(new URL(result.unwrap().redirectTo).searchParams.get('error')).toBe('access_denied');
		expect(createOAuthCode).not.toHaveBeenCalled();
	});

	test('a revoked agent, an expired request or a forged one is refused', async () => {
		getAgent.mockResolvedValue(Ok({id: 'agent-1', name: 'Dot', revokedAt: new Date()}));
		const revoked = await consent({request: sealed(), allow: true, agentId: 'agent-1'});
		const expired = await consent({request: sealed({expiresAt: Date.now() - 1}), allow: true, agentId: 'agent-1'});
		const forged = await consent({request: 'not-sealed', allow: true, agentId: 'agent-1'});

		expect(revoked.unwrapErr().kind).toBe('validation_error');
		expect(expired.unwrapErr().kind).toBe('validation_error');
		expect(forged.isErr()).toBe(true);
		expect(createOAuthCode).not.toHaveBeenCalled();
	});
});

describe('handleTokenRoute', () => {
	const verifier = 'verifier-with-enough-entropy-0123456789';
	const storedCode = {clientId: 'client-1', agentId: 'agent-1', redirectUri: REDIRECT, codeChallenge: sha256(verifier, 'base64url'), expires: new Date(Date.now() + 60_000)};

	async function token(body: Record<string, string>, headers: Record<string, string> = {}) {
		const {handleTokenRoute} = await import('./token');
		const res = makeRes();
		await handleTokenRoute({body, headers} as never, res as never);
		return res;
	}

	test('trades a code and its verifier for tokens, keeping only their hashes', async () => {
		takeOAuthCode.mockResolvedValue(Ok(storedCode));
		const res = await token({grant_type: 'authorization_code', code: 'code-1', code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'client-1'});
		const body = res.body as {access_token: string; refresh_token: string; token_type: string};

		expect(res.statusCode).toBe(200);
		expect(body.token_type).toBe('Bearer');
		expect(takeOAuthCode).toHaveBeenCalledWith(sha256('code-1'));
		expect(createOAuthGrant.mock.calls[0]?.[0]).toMatchObject({clientId: 'client-1', agentId: 'agent-1', accessTokenHash: sha256(body.access_token), refreshTokenHash: sha256(body.refresh_token)});
		expect(res.headers['cache-control']).toBe('no-store');
	});

	test('a wrong verifier, another client’s code, a used or expired one is invalid_grant', async () => {
		takeOAuthCode.mockResolvedValue(Ok(storedCode));
		const wrongVerifier = await token({grant_type: 'authorization_code', code: 'code-1', code_verifier: 'another-verifier', client_id: 'client-1'});
		takeOAuthCode.mockResolvedValue(Ok({...storedCode, clientId: 'client-2'}));
		const otherClient = await token({grant_type: 'authorization_code', code: 'code-1', code_verifier: verifier, client_id: 'client-1'});
		takeOAuthCode.mockResolvedValue(Ok(null));
		const used = await token({grant_type: 'authorization_code', code: 'code-1', code_verifier: verifier, client_id: 'client-1'});
		takeOAuthCode.mockResolvedValue(Ok({...storedCode, expires: new Date(Date.now() - 1)}));
		const expired = await token({grant_type: 'authorization_code', code: 'code-1', code_verifier: verifier, client_id: 'client-1'});

		for (const res of [wrongVerifier, otherClient, used, expired]) {
			expect(res.statusCode).toBe(400);
			expect(res.body).toMatchObject({error: 'invalid_grant'});
		}
		expect(createOAuthGrant).not.toHaveBeenCalled();
	});

	test('a refresh token is replaced, and refused once another refresh got there first', async () => {
		getOAuthGrantByRefreshToken.mockResolvedValue(Ok({id: 'grant-1', clientId: 'client-1', refreshExpires: new Date(Date.now() + 60_000), agentRevoked: false}));
		const fresh = await token({grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1'});
		rotateOAuthGrant.mockResolvedValue(Ok(false));
		const raced = await token({grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1'});

		expect(fresh.statusCode).toBe(200);
		expect(rotateOAuthGrant.mock.calls[0]?.slice(0, 2)).toEqual(['grant-1', sha256('refresh-1')]);
		expect(raced.body).toMatchObject({error: 'invalid_grant'});
	});

	test('a revoked agent’s refresh token is refused', async () => {
		getOAuthGrantByRefreshToken.mockResolvedValue(Ok({id: 'grant-1', clientId: 'client-1', refreshExpires: new Date(Date.now() + 60_000), agentRevoked: true}));
		const res = await token({grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1'});

		expect(res.body).toMatchObject({error: 'invalid_grant'});
		expect(rotateOAuthGrant).not.toHaveBeenCalled();
	});

	test('a client with a secret signs in with it, as HTTP Basic or in the body', async () => {
		getOAuthClient.mockResolvedValue(Ok({...publicClient, secretHash: sha256('s3cret')}));
		getOAuthGrantByRefreshToken.mockResolvedValue(Ok({id: 'grant-1', clientId: 'client-1', refreshExpires: new Date(Date.now() + 60_000), agentRevoked: false}));
		const basic = await token({grant_type: 'refresh_token', refresh_token: 'refresh-1'}, {authorization: `Basic ${Buffer.from('client-1:s3cret').toString('base64')}`});
		const inBody = await token({grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1', client_secret: 's3cret'});
		const wrong = await token({grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1', client_secret: 'nope'});
		const missing = await token({grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1'});

		expect(basic.statusCode).toBe(200);
		expect(inBody.statusCode).toBe(200);
		expect(wrong.statusCode).toBe(401);
		expect(missing.body).toMatchObject({error: 'invalid_client'});
	});

	test('any other grant type is unsupported', async () => {
		const res = await token({grant_type: 'password', client_id: 'client-1'});

		expect(res.body).toMatchObject({error: 'unsupported_grant_type'});
	});
});
