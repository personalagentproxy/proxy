import {createHash} from 'node:crypto';

import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

// How the api stores a code or a session's token: the hex of its SHA-256.
function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

const createDesktopAuthCode = mock();
const getDesktopAuthCode = mock();
const takeDesktopAuthCode = mock();

mock.module('@proxy/db/desktop-auth', () => ({
	createDesktopAuthCode,
	getDesktopAuthCode,
	takeDesktopAuthCode,
}));

const createSession = mock();

mock.module('@proxy/db/auth', () => ({createSession}));

const logWarn = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: logWarn, error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({
	env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'},
}));

// The app's side of PKCE: a verifier it keeps, and its challenge, as the page sends it.
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');

type RecordedCookie = {name: string; value: string; options: Record<string, string | boolean | Date>};

function makeRes() {
	const cookies: RecordedCookie[] = [];
	const res = {
		cookies,
		cookie: mock((name: string, value: string, options: RecordedCookie['options']) => {
			cookies.push({name, value, options});
		}),
		status: mock(() => res),
		json: mock(() => res),
	};
	return res;
}

function liveCode() {
	return {userId: 'user-1', challenge, expires: new Date(Date.now() + 60_000)};
}

beforeEach(() => {
	mock.clearAllMocks();
	createDesktopAuthCode.mockResolvedValue(Ok(undefined));
	getDesktopAuthCode.mockResolvedValue(Ok(liveCode()));
	takeDesktopAuthCode.mockResolvedValue(Ok(true));
	createSession.mockResolvedValue(Ok(undefined));
});

describe('handleDesktopCodeRoute', () => {
	test('mints a code for the signed-in person, bound to the challenge, and stores only its hash', async () => {
		const {handleDesktopCodeRoute} = await import('./desktop');
		const before = Date.now();

		const result = await handleDesktopCodeRoute({body: {challenge}, user: {userId: 'user-1'}} as never);

		expect(result.isOk()).toBe(true);
		const {code} = result.unwrap();
		expect(code).toMatch(/^[0-9a-f]{64}$/);
		const stored = createDesktopAuthCode.mock.calls[0]?.[0] as {codeHash: string; challenge: string; userId: string; expires: Date};
		expect(stored.codeHash).toBe(sha256(code));
		expect(stored.challenge).toBe(challenge);
		expect(stored.userId).toBe('user-1');
		// Minutes, not a session's weeks.
		expect(stored.expires.valueOf() - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
		expect(stored.expires.valueOf() - before).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
	});

	test('refuses a challenge that is not a base64url SHA-256', async () => {
		const {handleDesktopCodeRoute} = await import('./desktop');

		const result = await handleDesktopCodeRoute({body: {challenge: 'short'}, user: {userId: 'user-1'}} as never);

		expect(result.isErr()).toBe(true);
		expect(result.unwrapErr().kind).toBe('parse_error');
		expect(createDesktopAuthCode).not.toHaveBeenCalled();
	});
});

describe('handleDesktopSessionRoute', () => {
	test('trades a live code and its verifier for a session cookie, taking the code', async () => {
		const {handleDesktopSessionRoute} = await import('./desktop');
		const res = makeRes();

		await handleDesktopSessionRoute({body: {code: 'code-1', verifier}} as never, res as never);

		expect(getDesktopAuthCode).toHaveBeenCalledWith(sha256('code-1'));
		expect(takeDesktopAuthCode).toHaveBeenCalledWith(sha256('code-1'));
		const session = createSession.mock.calls[0]?.[0] as {tokenHash: string; userId: string};
		expect(session.userId).toBe('user-1');
		// The cookie has the token, the database its hash, as any sign-in's.
		expect(res.cookies).toHaveLength(1);
		expect(res.cookies[0]?.name).toBe('__Secure-proxy.session-token');
		expect(sha256(res.cookies[0]?.value ?? '')).toBe(session.tokenHash);
		expect(res.cookies[0]?.options).toMatchObject({httpOnly: true, sameSite: 'lax', path: '/', secure: true});
		expect(res.status).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith({ok: true});
	});

	test('a wrong verifier is refused without taking the code, so the right app can still use it', async () => {
		const {handleDesktopSessionRoute} = await import('./desktop');
		const res = makeRes();

		await handleDesktopSessionRoute({body: {code: 'code-1', verifier: 'w'.repeat(43)}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({error: 'invalid_code'});
		expect(takeDesktopAuthCode).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
		expect(res.cookies).toHaveLength(0);
		expect(logWarn).toHaveBeenCalled();
	});

	test('an unknown code is refused with the same answer', async () => {
		getDesktopAuthCode.mockResolvedValue(Ok(null));
		const {handleDesktopSessionRoute} = await import('./desktop');
		const res = makeRes();

		await handleDesktopSessionRoute({body: {code: 'nope', verifier}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({error: 'invalid_code'});
		expect(createSession).not.toHaveBeenCalled();
	});

	test('an expired code is refused', async () => {
		getDesktopAuthCode.mockResolvedValue(Ok({...liveCode(), expires: new Date(Date.now() - 1000)}));
		const {handleDesktopSessionRoute} = await import('./desktop');
		const res = makeRes();

		await handleDesktopSessionRoute({body: {code: 'code-1', verifier}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({error: 'invalid_code'});
		expect(takeDesktopAuthCode).not.toHaveBeenCalled();
	});

	test('a code taken by another request at the same moment signs no one in', async () => {
		takeDesktopAuthCode.mockResolvedValue(Ok(false));
		const {handleDesktopSessionRoute} = await import('./desktop');
		const res = makeRes();

		await handleDesktopSessionRoute({body: {code: 'code-1', verifier}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({error: 'invalid_code'});
		expect(createSession).not.toHaveBeenCalled();
	});

	test('a body without code and verifier is a 400', async () => {
		const {handleDesktopSessionRoute} = await import('./desktop');
		const res = makeRes();

		await handleDesktopSessionRoute({body: {code: 'code-1'}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({error: 'invalid_body'});
		expect(getDesktopAuthCode).not.toHaveBeenCalled();
	});

	test('a database failure is a 500, with no cookie', async () => {
		createSession.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));
		const {handleDesktopSessionRoute} = await import('./desktop');
		const res = makeRes();

		await handleDesktopSessionRoute({body: {code: 'code-1', verifier}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'internal_error'});
		expect(res.cookies).toHaveLength(0);
	});
});
