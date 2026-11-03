import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const acceptInvitation = mock();
const getInvitationByTokenHash = mock();

mock.module('@proxy/db/invitation', () => ({acceptInvitation, getInvitationByTokenHash}));

const getMembership = mock();

mock.module('@proxy/db/organization', () => ({getMembership}));

mock.module('../auth/session', () => ({hashToken: (token: string) => `hashed:${token}`}));

function makeRequest(email = 'sam@acme.com') {
	return {user: {userId: 'sam-1', email}, params: {token: 'token-1'}} as never;
}

const invitation = {
	id: 'inv-1',
	email: 'sam@acme.com',
	expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
	org: {id: 'org-2', slug: 'acme', name: 'Acme'},
	invitedBy: 'Maya Chen',
};

beforeEach(() => {
	mock.clearAllMocks();
	getInvitationByTokenHash.mockResolvedValue(Ok(invitation));
	getMembership.mockResolvedValue(Ok(null));
	acceptInvitation.mockResolvedValue(Ok(undefined));
});

describe('handleGetInvitationRoute', () => {
	test('says what it is for, by the hash of its token', async () => {
		const {handleGetInvitationRoute} = await import('./invitation-link');
		const result = await handleGetInvitationRoute(makeRequest());

		expect(getInvitationByTokenHash).toHaveBeenCalledWith('hashed:token-1');
		expect(result.unwrap()).toEqual({
			orgId: 'org-2',
			orgSlug: 'acme',
			orgName: 'Acme',
			invitedBy: 'Maya Chen',
			email: 'sam@acme.com',
			expired: false,
			member: false,
		});
	});

	test('an unknown link is not found', async () => {
		getInvitationByTokenHash.mockResolvedValue(Ok(null));
		const {handleGetInvitationRoute} = await import('./invitation-link');

		expect((await handleGetInvitationRoute(makeRequest())).unwrapErr().kind).toBe('not_found');
	});
});

describe('handleAcceptInvitationRoute', () => {
	test('makes the person at its address a member, answering with where to go', async () => {
		const {handleAcceptInvitationRoute} = await import('./invitation-link');
		const result = await handleAcceptInvitationRoute(makeRequest('Sam@Acme.com'));

		expect(acceptInvitation).toHaveBeenCalledWith({
			invitationId: 'inv-1',
			orgId: 'org-2',
			userId: 'sam-1',
			orgName: 'Acme',
			connections: [{integrationId: 'vault', shared: false, defaults: ['readEntries', 'writeEntries']}],
		});
		expect(result.unwrap()).toEqual({orgId: 'org-2', orgSlug: 'acme'});
	});

	test('refuses another address and an expired invitation', async () => {
		const {handleAcceptInvitationRoute} = await import('./invitation-link');
		const other = await handleAcceptInvitationRoute(makeRequest('jordan@acme.com'));
		getInvitationByTokenHash.mockResolvedValue(Ok({...invitation, expires: new Date(Date.now() - 1000)}));
		const expired = await handleAcceptInvitationRoute(makeRequest());

		expect(other.unwrapErr().kind).toBe('forbidden');
		expect(expired.unwrapErr().kind).toBe('validation_error');
		expect(acceptInvitation).not.toHaveBeenCalled();
	});
});
