import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const getUserFromId = mock();
const deleteUser = mock();
const getUserOrganization = mock();
const markOrganizationOnboarded = mock();
const listUserOrgs = mock();
const removeMembership = mock();
const listConnectionsWithCredential = mock();
const beforeDisconnect = mock();
const clearSessionCookie = mock();

mock.module('@proxy/db/user', () => ({
	getUserFromId,
	deleteUser,
}));

mock.module('@proxy/db/connection', () => ({listConnectionsWithCredential}));

mock.module('../connections/disconnect', () => ({beforeDisconnect}));

mock.module('../auth/session', () => ({clearSessionCookie}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('@proxy/db/organization', () => ({
	getUserOrganization,
	markOrganizationOnboarded,
	listUserOrgs,
	removeMembership,
}));

const user = {
	id: 'user-1',
	email: 'test@example.com',
	name: 'Test User',
	image: 'https://example.com/avatar.png',
	emailVerified: new Date('2026-01-01T00:00:00Z'),
};

function makeRequest(activeOrgId: string | null = 'org-2') {
	return {
		user: {userId: 'user-1', email: 'test@example.com', name: 'Test User', activeOrgId, experiments: []},
	};
}

const mine = {id: 'org-1', name: "Test's Workspace", role: 'owner', memberCount: 1, invitationCount: 0};

beforeEach(() => {
	mock.clearAllMocks();
	getUserFromId.mockResolvedValue(Ok(user));
	getUserOrganization.mockResolvedValue(Ok({id: 'org-2', name: 'Acme', role: 'member', onboardedAt: new Date('2026-02-01T00:00:00Z')}));
	markOrganizationOnboarded.mockResolvedValue(Ok(undefined));
	listUserOrgs.mockResolvedValue(Ok([mine]));
	removeMembership.mockResolvedValue(Ok(undefined));
	listConnectionsWithCredential.mockResolvedValue(Ok([]));
	beforeDisconnect.mockResolvedValue(undefined);
	deleteUser.mockResolvedValue(Ok(undefined));
});

describe('handleMeRoute', () => {
	test('returns the signed-in user, only the public fields, and the organization open in the switcher', async () => {
		const {handleMeRoute} = await import('./route');
		const result = await handleMeRoute(makeRequest() as never);

		expect(result.unwrap()).toEqual({
			user: {
				id: 'user-1',
				email: 'test@example.com',
				name: 'Test User',
				image: 'https://example.com/avatar.png',
			},
			org: {id: 'org-2', name: 'Acme', role: 'member'},
			onboarded: true,
			experiments: [],
		});
		expect(getUserFromId).toHaveBeenCalledWith('user-1');
		expect(getUserOrganization).toHaveBeenCalledWith('user-1', 'org-2');
	});

	test('without one open, works in the first one they joined', async () => {
		const {handleMeRoute} = await import('./route');
		await handleMeRoute(makeRequest(null) as never);

		expect(getUserOrganization).toHaveBeenCalledWith('user-1', null);
	});

	test('a new organization is not onboarded', async () => {
		getUserOrganization.mockResolvedValue(Ok({id: 'org-1', name: 'Mine', role: 'owner', onboardedAt: null}));

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
	test('marks the organization open onboarded', async () => {
		const {handleFinishOnboardingRoute} = await import('./route');
		const result = await handleFinishOnboardingRoute(makeRequest() as never);

		expect(result.isOk()).toBe(true);
		expect(markOrganizationOnboarded).toHaveBeenCalledWith('org-2');
	});

	test('returns unauthenticated when the user has no organization', async () => {
		getUserOrganization.mockResolvedValue(Ok(null));

		const {handleFinishOnboardingRoute} = await import('./route');
		const result = await handleFinishOnboardingRoute(makeRequest() as never);

		expect(result.unwrapErr().kind).toBe('unauthenticated');
		expect(markOrganizationOnboarded).not.toHaveBeenCalled();
	});
});

function makeRes() {
	const res = {status: mock(), end: mock(), json: mock()};
	res.status.mockReturnValue(res);
	return res;
}

describe('handleDeleteMeRoute', () => {
	const google = {id: 'conn-1', integrationId: 'google', credential: 'enc:google'};
	const bank = {id: 'conn-2', integrationId: 'plaid', credential: 'enc:plaid'};

	test('undoes every connection of an organization they own at its provider, then deletes the user, and signs out', async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([google, bank]));
		const order: string[] = [];
		beforeDisconnect.mockImplementation(async (connection: {id: string}) => {
			order.push(connection.id);
		});
		deleteUser.mockImplementation(async () => {
			order.push('user');
			return Ok(undefined);
		});
		const {handleDeleteMeRoute} = await import('./route');
		const res = makeRes();
		await handleDeleteMeRoute(makeRequest() as never, res as never);

		expect(listConnectionsWithCredential).toHaveBeenCalledWith('org-1');
		expect(removeMembership).not.toHaveBeenCalled();
		expect(order).toEqual(['conn-1', 'conn-2', 'user']);
		expect(deleteUser).toHaveBeenCalledWith('user-1');
		expect(clearSessionCookie).toHaveBeenCalledWith(res);
		expect(res.status).toHaveBeenCalledWith(204);
	});

	test('leaves an organization someone else owns, its connections untouched', async () => {
		listUserOrgs.mockResolvedValue(Ok([mine, {id: 'org-2', name: 'Acme', role: 'member', memberCount: 2, invitationCount: 0}]));
		const {handleDeleteMeRoute} = await import('./route');
		await handleDeleteMeRoute(makeRequest() as never, makeRes() as never);

		expect(listConnectionsWithCredential).toHaveBeenCalledTimes(1);
		expect(listConnectionsWithCredential).toHaveBeenCalledWith('org-1');
		expect(removeMembership).toHaveBeenCalledWith({orgId: 'org-2', userId: 'user-1'});
		expect(deleteUser).toHaveBeenCalledWith('user-1');
	});

	test('deletes an organization they own with others in it, every connection there undone first', async () => {
		listUserOrgs.mockResolvedValue(Ok([{id: 'org-2', name: 'Acme', role: 'owner', memberCount: 2, invitationCount: 0}]));
		listConnectionsWithCredential.mockResolvedValue(Ok([google, bank]));
		const {handleDeleteMeRoute} = await import('./route');
		const res = makeRes();
		await handleDeleteMeRoute(makeRequest() as never, res as never);

		expect(beforeDisconnect.mock.calls.map(([connection]) => connection)).toEqual([google, bank]);
		expect(removeMembership).not.toHaveBeenCalled();
		expect(deleteUser).toHaveBeenCalledWith('user-1');
		expect(res.status).toHaveBeenCalledWith(204);
	});

	test('a failed deletion keeps the person signed in, saying so', async () => {
		deleteUser.mockResolvedValue(Err(ApiErr.dbError(new Error('down'))));
		const {handleDeleteMeRoute} = await import('./route');
		const res = makeRes();
		await handleDeleteMeRoute(makeRequest() as never, res as never);

		expect(clearSessionCookie).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(500);
	});

	test('a user in no organization is still deleted', async () => {
		listUserOrgs.mockResolvedValue(Ok([]));
		const {handleDeleteMeRoute} = await import('./route');
		await handleDeleteMeRoute(makeRequest() as never, makeRes() as never);

		expect(listConnectionsWithCredential).not.toHaveBeenCalled();
		expect(deleteUser).toHaveBeenCalledWith('user-1');
	});
});
