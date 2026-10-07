import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const createSession = mock();
const deleteSessionByToken = mock();

mock.module('@proxy/db/auth', () => ({
	createSession,
	deleteSessionByToken,
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({
	env: {
		NODE_ENV: 'production',
		PROXY_API_PUBLIC_URL: 'https://api.example.com',
		SESSION_COOKIE_DOMAIN: '.example.com',
	},
}));

type ClearedCookie = {name: string; options: Record<string, string | boolean>};

function makeRes() {
	const clearedCookies: ClearedCookie[] = [];
	const res = {
		clearedCookies,
		clearCookie: mock((name: string, options: ClearedCookie['options']) => {
			clearedCookies.push({name, options});
		}),
		status: mock(() => res),
		json: mock(() => res),
	};
	return res;
}

function makeReq(cookieHeader?: string) {
	return {headers: cookieHeader ? {cookie: cookieHeader} : {}};
}

beforeEach(() => {
	mock.clearAllMocks();
	deleteSessionByToken.mockResolvedValue(Ok(undefined));
});

describe('handleSignOutRoute', () => {
	test('deletes the session row and clears the cookie with the set-time attributes', async () => {
		const {handleSignOutRoute} = await import('./signout');
		const res = makeRes();
		await handleSignOutRoute(makeReq('__Secure-proxy.session-token=tok-123') as never, res as never);

		expect(deleteSessionByToken).toHaveBeenCalledWith('tok-123');

		// Clearing only works with the name, path and domain the cookie was set with (prod here).
		expect(res.clearedCookies).toEqual([
			{
				name: '__Secure-proxy.session-token',
				options: {
					httpOnly: true,
					sameSite: 'lax',
					path: '/',
					secure: true,
					domain: '.example.com',
				},
			},
		]);
		expect(res.status).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith({ok: true});
	});

	test('succeeds without a session cookie: no delete, cookie still cleared', async () => {
		const {handleSignOutRoute} = await import('./signout');
		const res = makeRes();
		await handleSignOutRoute(makeReq() as never, res as never);

		expect(deleteSessionByToken).not.toHaveBeenCalled();
		expect(res.clearedCookies).toHaveLength(1);
		expect(res.json).toHaveBeenCalledWith({ok: true});
	});

	test('db failure → 500, cookie left in place so the session stays revocable', async () => {
		deleteSessionByToken.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleSignOutRoute} = await import('./signout');
		const res = makeRes();
		await handleSignOutRoute(makeReq('__Secure-proxy.session-token=tok-123') as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'signout_failed'});
		expect(res.clearedCookies).toHaveLength(0);
	});
});
