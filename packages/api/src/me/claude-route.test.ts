import {createHash} from 'node:crypto';

import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import type {ClaudeAccount} from '@proxy/contracts/me';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), APP_URL: 'http://localhost:5173'}}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const getClaudeAccount = mock();
const upsertClaudeAccount = mock();
const deleteClaudeAccount = mock();
mock.module('@proxy/db/claude-account', () => ({getClaudeAccount, upsertClaudeAccount, deleteClaudeAccount, updateClaudeAccountLocked: mock()}));

const exchangeCode = mock();
const oauth = await import('./claude-oauth');
mock.module('./claude-oauth', () => ({...oauth, exchangeCode}));

const {decryptSecret} = await import('../utils/secret-crypto');
const {handleClaudeCodeRoute, handleClaudeSignInRoute, handleClaudeTokenRoute, handleDeleteClaudeAccountRoute, handleGetClaudeAccountRoute} = await import('./claude-route');

type RecordedCookie = {name: string; value: string; options: Record<string, string | number | boolean>};

function makeRes() {
	const cookies: RecordedCookie[] = [];
	const res = {
		cookies,
		cookie: mock((name: string, value: string, options: RecordedCookie['options']) => {
			cookies.push({name, value, options});
		}),
		clearCookie: mock(),
		status: mock(() => res),
		json: mock((_body: object) => res),
		end: mock(() => res),
	};
	return res;
}

function makeRequest(options: {body?: unknown; cookie?: string; userId?: string} = {}) {
	return {
		body: options.body,
		headers: {cookie: options.cookie ?? ''},
		user: {userId: options.userId ?? 'user-1', sessionId: 'session-1', email: 'person@example.com'},
	} as never;
}

const row = {
	id: 'claude-1',
	userId: 'user-1',
	kind: 'oauth',
	credential: 'enc:tokens',
	email: null,
	subscriptionType: null,
	expiresAt: new Date('2026-11-09T20:00:00.000Z'),
	lastRefreshedAt: null,
	failedAt: null,
	failure: null,
	createdAt: new Date('2026-11-09T12:00:00.000Z'),
	updatedAt: new Date('2026-11-09T12:00:00.000Z'),
};

// What the GET shape says of `row`.
const describedAccount: NonNullable<ClaudeAccount['account']> = {
	kind: 'oauth',
	email: null,
	subscriptionType: null,
	expiresAt: '2026-11-09T20:00:00.000Z',
	failure: null,
	connectedAt: '2026-11-09T12:00:00.000Z',
};
const described: ClaudeAccount = {account: describedAccount};

// Begins a sign-in and answers the cookie header a browser would send back, with the state the
// page was sent.
async function beginSignIn(userId = 'user-1') {
	const res = makeRes();
	await handleClaudeSignInRoute(makeRequest({userId}), res as never);
	const cookie = res.cookies.find((one) => one.name === 'proxy.claude-state');
	if (!cookie) {
		throw new Error('no state cookie set');
	}
	const answered = res.json.mock.calls[0]?.[0] as {authorizeUrl: string} | undefined;
	if (!answered) {
		throw new Error('no answer sent');
	}
	const url = new URL(answered.authorizeUrl);
	return {cookieHeader: `proxy.claude-state=${encodeURIComponent(cookie.value)}`, cookie, url, state: url.searchParams.get('state') ?? ''};
}

beforeEach(() => {
	mock.clearAllMocks();
	getClaudeAccount.mockResolvedValue(Ok(null));
	upsertClaudeAccount.mockResolvedValue(Ok(row));
	deleteClaudeAccount.mockResolvedValue(Ok(undefined));
});

describe('handleGetClaudeAccountRoute', () => {
	test('null for a member who connected none', async () => {
		expect((await handleGetClaudeAccountRoute(makeRequest())).unwrap()).toEqual({account: null});
		expect(getClaudeAccount).toHaveBeenCalledWith('user-1');
	});

	test('the kind, the account and the expiry, never the credential', async () => {
		getClaudeAccount.mockResolvedValue(Ok({...row, email: 'dana@example.com', subscriptionType: 'max', failure: 'refused', failedAt: new Date()}));
		const answered = (await handleGetClaudeAccountRoute(makeRequest())).unwrap();
		expect(answered).toEqual({account: {...describedAccount, email: 'dana@example.com', subscriptionType: 'max', failure: 'refused'}});
		expect(JSON.stringify(answered)).not.toContain('enc:tokens');
	});
});

describe('handleClaudeSignInRoute', () => {
	test("keeps the handshake in an encrypted cookie for a quarter of an hour, on these routes alone, and answers Claude's sign-in page for it", async () => {
		const {cookie, url} = await beginSignIn();

		expect(cookie.options).toMatchObject({httpOnly: true, sameSite: 'lax', secure: false, path: '/api/me/claude', maxAge: 15 * 60 * 1000});
		const payload = JSON.parse(decryptSecret(cookie.value).unwrap()) as {state: string; verifier: string; userId: string};
		expect(payload.userId).toBe('user-1');
		expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
		expect(url.searchParams.get('state')).toBe(payload.state);
		expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(payload.verifier).digest('base64url'));
		expect(url.searchParams.get('code')).toBe('true');
	});
});

describe('handleClaudeCodeRoute', () => {
	const credential = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date('2026-11-09T20:00:00.000Z'), scopes: ['user:profile', 'user:inference']};

	test('trades the pasted code for the tokens with the handshake, stores them encrypted, clears the cookie and answers the account', async () => {
		const {cookieHeader, cookie, state} = await beginSignIn();
		exchangeCode.mockResolvedValue(Ok(credential));
		const res = makeRes();

		await handleClaudeCodeRoute(makeRequest({body: {code: `the-code#${state}`}, cookie: cookieHeader}), res as never);

		const payload = JSON.parse(decryptSecret(cookie.value).unwrap()) as {verifier: string};
		expect(exchangeCode).toHaveBeenCalledWith({code: 'the-code', verifier: payload.verifier, state});
		expect(upsertClaudeAccount).toHaveBeenCalledWith('user-1', {kind: 'oauth', credential: expect.any(String), expiresAt: credential.expiresAt});
		const stored = (upsertClaudeAccount.mock.calls[0] as [string, {credential: string}])[1].credential;
		expect(stored).not.toContain('refresh-1');
		expect(JSON.parse(decryptSecret(stored).unwrap())).toEqual({accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: '2026-11-09T20:00:00.000Z', scopes: ['user:profile', 'user:inference']});
		expect(res.clearCookie).toHaveBeenCalledWith('proxy.claude-state', expect.objectContaining({path: '/api/me/claude'}));
		expect(res.json).toHaveBeenCalledWith(described);
	});

	test('without a sign-in under way it is a bad request, and nothing is exchanged', async () => {
		const res = makeRes();
		await handleClaudeCodeRoute(makeRequest({body: {code: 'the-code#st'}}), res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({error: 'validation_error', message: expect.stringContaining('No Claude sign-in')}));
		expect(exchangeCode).not.toHaveBeenCalled();
	});

	test("another person's handshake is no good", async () => {
		const {cookieHeader, state} = await beginSignIn('user-2');
		const res = makeRes();
		await handleClaudeCodeRoute(makeRequest({body: {code: `the-code#${state}`}, cookie: cookieHeader}), res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(exchangeCode).not.toHaveBeenCalled();
	});

	test('a code from another attempt is refused, saying so, and the handshake is cleared', async () => {
		const {cookieHeader} = await beginSignIn();
		const res = makeRes();
		await handleClaudeCodeRoute(makeRequest({body: {code: 'the-code#other-state'}, cookie: cookieHeader}), res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('different sign-in attempt')}));
		expect(res.clearCookie).toHaveBeenCalled();
		expect(exchangeCode).not.toHaveBeenCalled();
		expect(upsertClaudeAccount).not.toHaveBeenCalled();
	});

	test("a refused exchange is the exchange's error, and nothing is stored", async () => {
		const {cookieHeader, state} = await beginSignIn();
		exchangeCode.mockResolvedValue(Err(ApiErr.unavailable('Claude sign-in failed. Try again.')));
		const res = makeRes();
		await handleClaudeCodeRoute(makeRequest({body: {code: `the-code#${state}`}, cookie: cookieHeader}), res as never);

		expect(res.status).toHaveBeenCalledWith(503);
		expect(upsertClaudeAccount).not.toHaveBeenCalled();
	});

	test('an empty body is a bad request', async () => {
		const res = makeRes();
		await handleClaudeCodeRoute(makeRequest({body: {}}), res as never);
		expect(res.status).toHaveBeenCalledWith(400);
	});
});

describe('handleClaudeTokenRoute', () => {
	test('a setup token is stored encrypted as its kind', async () => {
		upsertClaudeAccount.mockResolvedValue(Ok({...row, kind: 'setup_token', expiresAt: null}));
		const answered = (await handleClaudeTokenRoute(makeRequest({body: {token: 'sk-ant-oat01-abc'}}))).unwrap();

		expect(answered.account?.kind).toBe('setup_token');
		expect(answered.account?.expiresAt).toBeNull();
		const [userId, stored] = upsertClaudeAccount.mock.calls[0] as [string, {kind: string; credential: string}];
		expect(userId).toBe('user-1');
		expect(stored.kind).toBe('setup_token');
		expect(stored.credential).not.toContain('sk-ant');
		expect(JSON.parse(decryptSecret(stored.credential).unwrap())).toEqual({token: 'sk-ant-oat01-abc'});
	});

	test('an API key is stored as a key', async () => {
		upsertClaudeAccount.mockResolvedValue(Ok({...row, kind: 'api_key', expiresAt: null}));
		expect((await handleClaudeTokenRoute(makeRequest({body: {token: '  sk-ant-api03-abc  '}}))).unwrap().account?.kind).toBe('api_key');
		const [, stored] = upsertClaudeAccount.mock.calls[0] as [string, {kind: string; credential: string}];
		expect(stored.kind).toBe('api_key');
		expect(JSON.parse(decryptSecret(stored.credential).unwrap())).toEqual({key: 'sk-ant-api03-abc'});
	});

	test('anything else is refused, saying what to paste', async () => {
		const error = (await handleClaudeTokenRoute(makeRequest({body: {token: 'hunter2'}}))).unwrapErr();
		expect(error.kind).toBe('validation_error');
		expect(upsertClaudeAccount).not.toHaveBeenCalled();
	});
});

describe('handleDeleteClaudeAccountRoute', () => {
	test('disconnects and answers no account', async () => {
		expect((await handleDeleteClaudeAccountRoute(makeRequest())).unwrap()).toEqual({account: null});
		expect(deleteClaudeAccount).toHaveBeenCalledWith('user-1');
	});
});
