import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr, sessionCookieNames} from '@proxy/utils';

const getAuthenticatedSessionDatabase = mock();
const setSessionUserAgent = mock();

mock.module('@proxy/db/auth', () => ({createSession: mock(), getAuthenticatedSessionDatabase, setSessionUserAgent}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('./env', () => ({env: {NODE_ENV: 'test', APP_URL: 'http://localhost:5173'}}));

const APP_USER_AGENT = 'Mozilla/5.0 (Macintosh) Chrome/146.0 Electron/41.10.7 Safari/537.36 PersonalAgentProxyDesktop/0.0.6';

function sessionWith(userAgent: string | null) {
	return {
		id: 'session-1',
		userId: 'user-1',
		user: {email: 'test@example.com', name: null},
		expires: new Date(Date.now() + 60_000),
		userAgent,
	};
}

function headers(userAgent?: string) {
	return {cookie: `${sessionCookieNames.insecure}=token`, 'user-agent': userAgent};
}

beforeEach(() => {
	mock.clearAllMocks();
	setSessionUserAgent.mockResolvedValue(Ok(undefined));
});

describe('authenticateApiRequest', () => {
	test('keeps the User-Agent the session is used with when it changed, as an updated desktop app’s has', async () => {
		getAuthenticatedSessionDatabase.mockResolvedValue(Ok(sessionWith(APP_USER_AGENT.replace('0.0.6', '0.0.5'))));
		const {authenticateApiRequest} = await import('./auth');

		const result = await authenticateApiRequest(headers(APP_USER_AGENT));

		expect(result.unwrap().sessionId).toBe('session-1');
		expect(setSessionUserAgent).toHaveBeenCalledWith({sessionId: 'session-1', userAgent: APP_USER_AGENT});
	});

	test('gives a session from before User-Agents were kept the one it is used with', async () => {
		getAuthenticatedSessionDatabase.mockResolvedValue(Ok(sessionWith(null)));
		const {authenticateApiRequest} = await import('./auth');

		await authenticateApiRequest(headers(APP_USER_AGENT));

		expect(setSessionUserAgent).toHaveBeenCalledWith({sessionId: 'session-1', userAgent: APP_USER_AGENT});
	});

	test('writes nothing when it is the same, or the request has none', async () => {
		getAuthenticatedSessionDatabase.mockResolvedValue(Ok(sessionWith(APP_USER_AGENT)));
		const {authenticateApiRequest} = await import('./auth');

		await authenticateApiRequest(headers(APP_USER_AGENT));
		await authenticateApiRequest(headers());

		expect(setSessionUserAgent).not.toHaveBeenCalled();
	});

	test('a failed write still lets the request in', async () => {
		getAuthenticatedSessionDatabase.mockResolvedValue(Ok(sessionWith(null)));
		setSessionUserAgent.mockResolvedValue(Err(ApiErr.internalError('db down')));
		const {authenticateApiRequest} = await import('./auth');

		const result = await authenticateApiRequest(headers(APP_USER_AGENT));

		expect(result.isOk()).toBe(true);
	});
});
