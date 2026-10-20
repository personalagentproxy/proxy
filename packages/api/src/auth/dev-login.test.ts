import {createHash} from 'node:crypto';

import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

// How the api stores a session's token: the hex of its SHA-256.
function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

const createSession = mock();

mock.module('@proxy/db/auth', () => ({
	createSession,
}));

const createUser = mock();
const getUserByEmail = mock();

mock.module('@proxy/db/user', () => ({
	createUser,
	getUserByEmail,
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

// Mutable so a test can flip NODE_ENV; the route reads it per request.
const mockEnv: {NODE_ENV: string} = {
	NODE_ENV: 'development',
};

mock.module('../utils/env', () => ({env: mockEnv}));

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

const devUser = {id: 'user-dev', email: 'dev@dev.proxy.local', name: 'Dev User'};
const throwawayUser = {id: 'user-throwaway', email: 'dev-abc@dev.proxy.local', name: 'Dev User'};

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.NODE_ENV = 'development';
	getUserByEmail.mockResolvedValue(Ok(null));
	createUser.mockResolvedValue(Ok(devUser));
	createSession.mockResolvedValue(Ok(undefined));
});

describe('handleDevLoginRoute', () => {
	test('outside development → 404 as if the route did not exist', async () => {
		mockEnv.NODE_ENV = 'production';

		const {handleDevLoginRoute} = await import('./dev-login');
		const res = makeRes();
		await handleDevLoginRoute({body: {}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(res.json).toHaveBeenCalledWith({error: 'not_found'});
		expect(createUser).not.toHaveBeenCalled();
	});

	test('first sign-in creates the dev user and a session, sets the dev cookie', async () => {
		const {handleDevLoginRoute} = await import('./dev-login');
		const res = makeRes();
		await handleDevLoginRoute({body: {}} as never, res as never);

		expect(getUserByEmail).toHaveBeenCalledWith('dev@dev.proxy.local');
		const createUserArgs = createUser.mock.calls[0]?.[0] as {email: string; name: string; emailVerified: Date};
		expect(createUserArgs.email).toBe('dev@dev.proxy.local');
		expect(createUserArgs.name).toBe('Dev User');
		expect(createUserArgs.emailVerified).toBeInstanceOf(Date);

		const sessionArgs = createSession.mock.calls[0]?.[0] as {tokenHash: string; userId: string; expires: Date};
		expect(sessionArgs.userId).toBe(devUser.id);
		expect(sessionArgs.tokenHash).toMatch(/^[0-9a-f]{64}$/);

		// Dev naming: not secure, host-only.
		const sessionCookie = res.cookies.find((cookie) => cookie.name === 'proxy.session-token');
		// The cookie has the token, the database only its hash.
		expect(sha256(sessionCookie?.value ?? '')).toBe(sessionArgs.tokenHash);
		expect(sessionCookie?.options).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: false,
		});
		expect(sessionCookie?.options).not.toHaveProperty('domain');

		expect(res.status).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith({ok: true});
	});

	test('later sign-ins reuse the dev user', async () => {
		getUserByEmail.mockResolvedValue(Ok(devUser));

		const {handleDevLoginRoute} = await import('./dev-login');
		const res = makeRes();
		await handleDevLoginRoute({body: {}} as never, res as never);

		expect(createUser).not.toHaveBeenCalled();
		const sessionArgs = createSession.mock.calls[0]?.[0] as {userId: string};
		expect(sessionArgs.userId).toBe(devUser.id);
		expect(res.json).toHaveBeenCalledWith({ok: true});
	});

	test('fresh → a throwaway user on the dev domain', async () => {
		createUser.mockResolvedValue(Ok(throwawayUser));

		const {handleDevLoginRoute} = await import('./dev-login');
		const res = makeRes();
		await handleDevLoginRoute({body: {fresh: true}} as never, res as never);

		expect(getUserByEmail).not.toHaveBeenCalled();
		const createUserArgs = createUser.mock.calls[0]?.[0] as {email: string};
		expect(createUserArgs.email).toMatch(/^dev-[0-9a-f]{16}@dev\.proxy\.local$/);
		const sessionArgs = createSession.mock.calls[0]?.[0] as {userId: string};
		expect(sessionArgs.userId).toBe(throwawayUser.id);
	});

	test('lookup failure → 500, no user created', async () => {
		getUserByEmail.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleDevLoginRoute} = await import('./dev-login');
		const res = makeRes();
		await handleDevLoginRoute({body: {}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'user_creation_failed'});
		expect(createUser).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('user creation failure → 500, no session', async () => {
		createUser.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleDevLoginRoute} = await import('./dev-login');
		const res = makeRes();
		await handleDevLoginRoute({body: {}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'user_creation_failed'});
		expect(createSession).not.toHaveBeenCalled();
		expect(res.cookies).toHaveLength(0);
	});

	test('session creation failure → 500, no cookie', async () => {
		createSession.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleDevLoginRoute} = await import('./dev-login');
		const res = makeRes();
		await handleDevLoginRoute({body: {}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'session_creation_failed'});
		expect(res.cookies).toHaveLength(0);
	});
});
