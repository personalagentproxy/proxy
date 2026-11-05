import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const listUserSessions = mock();
const deleteUserSession = mock();
const deleteOtherUserSessions = mock();

mock.module('@proxy/db/auth', () => ({listUserSessions, deleteUserSession, deleteOtherUserSessions}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

function makeRequest(params: Record<string, string> = {}) {
	return {
		params,
		user: {sessionId: 'session-here', userId: 'user-1', email: 'test@example.com'},
	} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	deleteUserSession.mockResolvedValue(Ok(true));
	deleteOtherUserSessions.mockResolvedValue(Ok(2));
});

describe('handleListSessionsRoute', () => {
	test('describes each session and marks the one asking', async () => {
		listUserSessions.mockResolvedValue(
			Ok([
				{id: 'session-here', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36', createdAt: new Date('2026-11-01T10:00:00Z')},
				{id: 'session-old', userAgent: null, createdAt: new Date('2026-10-01T10:00:00Z')},
			]),
		);
		const {handleListSessionsRoute} = await import('./sessions');

		const result = await handleListSessionsRoute(makeRequest());

		expect(listUserSessions).toHaveBeenCalledWith('user-1');
		expect(result.unwrap()).toEqual({
			sessions: [
				{id: 'session-here', client: 'Chrome', os: 'macOS', createdAt: '2026-11-01T10:00:00.000Z', current: true},
				{id: 'session-old', client: null, os: null, createdAt: '2026-10-01T10:00:00.000Z', current: false},
			],
		});
	});
});

describe('handleDeleteSessionRoute', () => {
	test("signs another of the person's sessions out", async () => {
		const {handleDeleteSessionRoute} = await import('./sessions');

		const result = await handleDeleteSessionRoute(makeRequest({sessionId: 'session-old'}));

		expect(result.isOk()).toBe(true);
		expect(deleteUserSession).toHaveBeenCalledWith({userId: 'user-1', sessionId: 'session-old'});
	});

	test('refuses the session asking, which signs out instead', async () => {
		const {handleDeleteSessionRoute} = await import('./sessions');

		const result = await handleDeleteSessionRoute(makeRequest({sessionId: 'session-here'}));

		expect(result.isErr() && result.error.kind).toBe('validation_error');
		expect(deleteUserSession).not.toHaveBeenCalled();
	});

	test("404s a session that isn't theirs or is gone", async () => {
		deleteUserSession.mockResolvedValue(Ok(false));
		const {handleDeleteSessionRoute} = await import('./sessions');

		const result = await handleDeleteSessionRoute(makeRequest({sessionId: 'someone-elses'}));

		expect(result.isErr() && result.error.kind).toBe('not_found');
	});
});

describe('handleDeleteOtherSessionsRoute', () => {
	test('keeps only the session asking', async () => {
		const {handleDeleteOtherSessionsRoute} = await import('./sessions');

		const result = await handleDeleteOtherSessionsRoute(makeRequest());

		expect(result.isOk()).toBe(true);
		expect(deleteOtherUserSessions).toHaveBeenCalledWith({userId: 'user-1', keepSessionId: 'session-here'});
	});
});
