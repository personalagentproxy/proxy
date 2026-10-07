import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const createSession = mock();

mock.module('@proxy/db/auth', () => ({
	createSession,
}));

const logError = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: logError},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({
	env: {
		NODE_ENV: 'development',
	},
}));

type RecordedCookie = {name: string; value: string; options: Record<string, string | boolean | Date>};

function makeRes() {
	const cookies: RecordedCookie[] = [];
	return {
		cookies,
		redirect: mock(),
		cookie: mock((name: string, value: string, options: RecordedCookie['options']) => {
			cookies.push({name, value, options});
		}),
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	createSession.mockResolvedValue(Ok(undefined));
});

describe('establishSession', () => {
	test('stores a session row and sets a host-only dev cookie with the same token', async () => {
		const {establishSession, sessionMaxAgeSeconds} = await import('./session');
		const res = makeRes();
		const before = Date.now();

		const result = await establishSession(res as never, 'user-1');

		expect(result.isOk()).toBe(true);
		const sessionArgs = createSession.mock.calls[0]?.[0] as {sessionToken: string; userId: string; expires: Date};
		expect(sessionArgs.userId).toBe('user-1');
		expect(sessionArgs.sessionToken).toMatch(/^[0-9a-f]{64}$/);
		expect(sessionArgs.expires.valueOf() - before).toBeGreaterThanOrEqual(sessionMaxAgeSeconds * 1000 - 1000);

		expect(res.cookies).toEqual([
			{
				name: 'proxy.session-token',
				value: sessionArgs.sessionToken,
				options: {httpOnly: true, sameSite: 'lax', path: '/', secure: false, expires: sessionArgs.expires},
			},
		]);
	});

	test('session creation failure → Err, no cookie', async () => {
		createSession.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {establishSession} = await import('./session');
		const res = makeRes();

		const result = await establishSession(res as never, 'user-1');

		expect(result.isErr()).toBe(true);
		expect(res.cookies).toHaveLength(0);
	});
});

describe('establishSessionAndRedirect', () => {
	test('sets the session cookie and redirects to the callbackUrl', async () => {
		const {establishSessionAndRedirect} = await import('./session');
		const res = makeRes();

		await establishSessionAndRedirect(res as never, {appUrl: 'https://app.test', callbackUrl: '/editor/x', userId: 'user-1'});

		const cookie = res.cookies.find((c) => c.name === 'proxy.session-token');
		expect(cookie?.value).toMatch(/^[0-9a-f]{64}$/);
		expect(res.redirect).toHaveBeenCalledWith('https://app.test/editor/x');
	});

	test('session creation failure → error redirect, no cookie', async () => {
		createSession.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {establishSessionAndRedirect} = await import('./session');
		const res = makeRes();

		await establishSessionAndRedirect(res as never, {appUrl: 'https://app.test', callbackUrl: '/editor/x', userId: 'user-1'});

		expect(res.cookies).toHaveLength(0);
		expect(logError).toHaveBeenCalledTimes(1);
		expect(res.redirect).toHaveBeenCalledWith('https://app.test/login?error=Callback');
	});
});

describe('sanitizeCallbackUrl', () => {
	test('keeps same-site paths', async () => {
		const {sanitizeCallbackUrl} = await import('./session');

		expect(sanitizeCallbackUrl('/')).toBe('/');
		expect(sanitizeCallbackUrl('/editor/x?tab=1')).toBe('/editor/x?tab=1');
	});

	test('drops empty, absolute, protocol-relative and backslash URLs', async () => {
		const {sanitizeCallbackUrl} = await import('./session');

		expect(sanitizeCallbackUrl(undefined)).toBeUndefined();
		expect(sanitizeCallbackUrl('')).toBeUndefined();
		expect(sanitizeCallbackUrl('https://evil.com')).toBeUndefined();
		expect(sanitizeCallbackUrl('//evil.com')).toBeUndefined();
		expect(sanitizeCallbackUrl('/\\evil.com')).toBeUndefined();
	});
});
