import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const getUserFromId = mock();
const getUserOrganization = mock();
const markOrganizationOnboarded = mock();

mock.module('@proxy/db/user', () => ({
	getUserFromId,
}));

mock.module('@proxy/db/organization', () => ({
	getUserOrganization,
	markOrganizationOnboarded,
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
	getUserOrganization.mockResolvedValue(Ok({id: 'org-1', onboardedAt: new Date('2026-02-01T00:00:00Z')}));
	markOrganizationOnboarded.mockResolvedValue(Ok(undefined));
});

describe('handleMeRoute', () => {
	test('returns the signed-in user, only the public fields, and that the welcome flow is done', async () => {
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
			onboarded: true,
		});
		expect(getUserFromId).toHaveBeenCalledWith('user-1');
		expect(getUserOrganization).toHaveBeenCalledWith('user-1');
	});

	test('a new organization is not onboarded', async () => {
		getUserOrganization.mockResolvedValue(Ok({id: 'org-1', onboardedAt: null}));

		const {handleMeRoute} = await import('./route');
		const result = await handleMeRoute(makeRequest() as never);

		expect(result.unwrap().onboarded).toBe(false);
	});

	test('returns unauthenticated when the session user no longer exists', async () => {
		getUserFromId.mockResolvedValue(Ok(null));

		const {handleMeRoute} = await import('./route');
		const result = await handleMeRoute(makeRequest() as never);

		expect(result.isErr()).toBe(true);
		expect(result.unwrapErr().kind).toBe('unauthenticated');
	});

	test('returns unauthenticated when the user has no organization', async () => {
		getUserOrganization.mockResolvedValue(Ok(null));

		const {handleMeRoute} = await import('./route');
		const result = await handleMeRoute(makeRequest() as never);

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

describe('handleFinishOnboardingRoute', () => {
	test("marks the user's organization onboarded", async () => {
		const {handleFinishOnboardingRoute} = await import('./route');
		const result = await handleFinishOnboardingRoute(makeRequest() as never);

		expect(result.isOk()).toBe(true);
		expect(markOrganizationOnboarded).toHaveBeenCalledWith('org-1');
	});

	test('returns unauthenticated when the user has no organization', async () => {
		getUserOrganization.mockResolvedValue(Ok(null));

		const {handleFinishOnboardingRoute} = await import('./route');
		const result = await handleFinishOnboardingRoute(makeRequest() as never);

		expect(result.unwrapErr().kind).toBe('unauthenticated');
		expect(markOrganizationOnboarded).not.toHaveBeenCalled();
	});
});
