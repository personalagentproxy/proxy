import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const getUserFromId = mock();

mock.module('@proxy/db/user', () => ({
	getUserFromId,
}));

const user = {
	id: 'user-1',
	email: 'test@example.com',
	name: 'Test User',
	image: 'https://example.com/avatar.png',
	emailVerified: new Date('2026-01-01T00:00:00Z'),
};

function makeRequest() {
	return {
		user: {userId: 'user-1', email: 'test@example.com', name: 'Test User'},
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	getUserFromId.mockResolvedValue(Ok(user));
});

describe('handleMeRoute', () => {
	test('returns the signed-in user, only the public fields', async () => {
		const {handleMeRoute} = await import('./route');
		const result = await handleMeRoute(makeRequest() as never);

		expect(result.isOk()).toBe(true);
		expect(result.unwrap()).toEqual({
			user: {
				id: 'user-1',
				email: 'test@example.com',
				name: 'Test User',
				image: 'https://example.com/avatar.png',
			},
		});
		expect(getUserFromId).toHaveBeenCalledWith('user-1');
	});

	test('returns unauthenticated when the session user no longer exists', async () => {
		getUserFromId.mockResolvedValue(Ok(null));

		const {handleMeRoute} = await import('./route');
		const result = await handleMeRoute(makeRequest() as never);

		expect(result.isErr()).toBe(true);
		expect(result.unwrapErr().kind).toBe('unauthenticated');
	});

	test('propagates db errors', async () => {
		getUserFromId.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleMeRoute} = await import('./route');
		const result = await handleMeRoute(makeRequest() as never);

		expect(result.isErr()).toBe(true);
		expect(result.unwrapErr().kind).toBe('db_error');
	});
});
