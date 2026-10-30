import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const listOrgConnectionsWithCredential = mock();
const listOwnConnectionsWithCredential = mock();

mock.module('@proxy/db/connection', () => ({listOrgConnectionsWithCredential, listOwnConnectionsWithCredential}));

const createInvitation = mock();
const deleteInvitation = mock();
const listInvitations = mock();

mock.module('@proxy/db/invitation', () => ({createInvitation, deleteInvitation, listInvitations}));

const deleteOwnedOrganization = mock();
const listMembers = mock();
const listUserOrgs = mock();
const markOrganizationOnboarded = mock();
const removeMembership = mock();
const renameOrganization = mock();
const getMembership = mock();
const getMemberOrganization = mock();

mock.module('@proxy/db/organization', () => ({
	deleteOwnedOrganization,
	listMembers,
	listUserOrgs,
	markOrganizationOnboarded,
	removeMembership,
	renameOrganization,
	getMembership,
	getMemberOrganization,
}));

const createOrganization = mock();

mock.module('./provision', () => ({createOrganization}));

const getUserByEmail = mock();

mock.module('@proxy/db/user', () => ({getUserByEmail}));

const sendInvitation = mock();

mock.module('../auth/mail', () => ({sendInvitation}));

const canSignUp = mock();

mock.module('../auth/session', () => ({canSignUp, hashToken: (token: string) => `hashed:${token}`}));

const beforeDisconnectAll = mock();

mock.module('../connections/disconnect', () => ({beforeDisconnectAll}));

const info = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info, warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const env: {NODE_ENV: string; APP_URL: string; RESEND_KEY?: string} = {NODE_ENV: 'production', APP_URL: 'https://app.example.com', RESEND_KEY: 'key'};

mock.module('../utils/env', () => ({env}));

// The organizations as the database answers them: the person's first, their own, and Acme, which
// they own too and others are in.
const mine = {id: 'org-1', slug: 'alexs-workspace', name: "Alex's Workspace", role: 'owner' as const, onboarded: true, memberCount: 1, invitationCount: 0};
const acme = {id: 'org-2', slug: 'acme', name: 'Acme', role: 'owner' as const, onboarded: true, memberCount: 3, invitationCount: 1};

// A request about an organization, by its slug in the address.
function makeRequest(params: Record<string, string> = {}, body: unknown = undefined) {
	return {user: {userId: 'user-1', email: 'alex@example.com', name: 'Alex'}, params: {org: 'acme', ...params}, body} as never;
}

function member(userId: string, role: 'owner' | 'member', email = `${userId}@example.com`) {
	return {userId, name: null, email, image: null, role, joinedAt: new Date('2026-10-01T00:00:00Z')};
}

// What a member sees of an organization by its slug, as `requireViewer` reads it.
function membership(role: 'owner' | 'member') {
	return {id: 'org-2', slug: 'acme', name: 'Acme', role, onboardedAt: new Date('2026-09-01T00:00:00Z'), experiments: []};
}

beforeEach(() => {
	mock.clearAllMocks();
	env.NODE_ENV = 'production';
	env.RESEND_KEY = 'key';
	getMemberOrganization.mockResolvedValue(Ok(membership('owner')));
	getMembership.mockResolvedValue(Ok({role: 'owner'}));
	listUserOrgs.mockResolvedValue(Ok([mine, acme]));
	listMembers.mockResolvedValue(Ok([member('user-1', 'owner', 'alex@example.com'), member('maya-1', 'member'), member('jonas-1', 'member')]));
	listOrgConnectionsWithCredential.mockResolvedValue(Ok([]));
	listOwnConnectionsWithCredential.mockResolvedValue(Ok([]));
	markOrganizationOnboarded.mockResolvedValue(Ok(undefined));
	removeMembership.mockResolvedValue(Ok(undefined));
	deleteOwnedOrganization.mockResolvedValue(Ok(true));
	renameOrganization.mockResolvedValue(Ok(undefined));
	beforeDisconnectAll.mockResolvedValue(undefined);
	getUserByEmail.mockResolvedValue(Ok(null));
	canSignUp.mockReturnValue(true);
	createInvitation.mockImplementation(async (data: {email: string; expires: Date}) => Ok({id: 'inv-1', email: data.email, invitedBy: 'Alex', expires: data.expires, createdAt: new Date()}));
	deleteInvitation.mockResolvedValue(Ok(true));
	listInvitations.mockResolvedValue(Ok([]));
	sendInvitation.mockResolvedValue(Ok(undefined));
});

describe('handleListOrgsRoute', () => {
	test('lists the person’s organizations by their slugs', async () => {
		const {handleListOrgsRoute} = await import('./route');
		const result = await handleListOrgsRoute(makeRequest());

		expect(result.unwrap().orgs.map((org) => [org.slug, org.role, org.onboarded])).toEqual([
			['alexs-workspace', 'owner', true],
			['acme', 'owner', true],
		]);
	});
});

describe('handleGetOrgRoute', () => {
	test('answers the organization in the address, with the person’s role and its experiments', async () => {
		getMemberOrganization.mockResolvedValue(Ok({...membership('member'), experiments: ['ask']}));
		listUserOrgs.mockResolvedValue(Ok([mine, {...acme, role: 'member' as const}]));
		const {handleGetOrgRoute} = await import('./route');
		const result = await handleGetOrgRoute(makeRequest());

		expect(getMemberOrganization).toHaveBeenCalledWith('user-1', 'acme');
		expect(result.unwrap()).toEqual({...acme, role: 'member', experiments: ['ask']});
	});

	test('one the person isn’t in is not found, as is one that doesn’t exist', async () => {
		getMemberOrganization.mockResolvedValue(Ok(null));
		const {handleGetOrgRoute} = await import('./route');

		expect((await handleGetOrgRoute(makeRequest({org: 'elsewhere'}))).unwrapErr().kind).toBe('not_found');
	});
});

describe('handleCreateOrgRoute', () => {
	test('makes one, the person its owner, answering with its slug', async () => {
		createOrganization.mockResolvedValue(Ok({id: 'org-3', slug: 'lab', name: 'Lab'}));

		const {handleCreateOrgRoute} = await import('./route');
		const result = await handleCreateOrgRoute(makeRequest({}, {name: '  Lab '}));

		expect(createOrganization).toHaveBeenCalledWith({userId: 'user-1', name: 'Lab'});
		expect(result.unwrap()).toEqual({id: 'org-3', slug: 'lab', name: 'Lab', role: 'owner', onboarded: true, experiments: [], memberCount: 1, invitationCount: 0});
	});

	test('needs a name', async () => {
		const {handleCreateOrgRoute} = await import('./route');
		const result = await handleCreateOrgRoute(makeRequest({}, {name: ' '}));

		expect(result.unwrapErr().kind).toBe('parse_error');
		expect(createOrganization).not.toHaveBeenCalled();
	});
});

describe('handleFinishOnboardingRoute', () => {
	test('marks the organization in the address onboarded', async () => {
		const {handleFinishOnboardingRoute} = await import('./route');
		const result = await handleFinishOnboardingRoute(makeRequest());

		expect(result.isOk()).toBe(true);
		expect(markOrganizationOnboarded).toHaveBeenCalledWith('org-2');
	});
});

describe('handleRenameOrgRoute', () => {
	test('its owner renames it; members can’t', async () => {
		const {handleRenameOrgRoute} = await import('./route');
		await handleRenameOrgRoute(makeRequest({}, {name: 'Acme Inc'}));
		getMemberOrganization.mockResolvedValue(Ok(membership('member')));
		const asMember = await handleRenameOrgRoute(makeRequest({}, {name: 'Mine now'}));

		expect(renameOrganization).toHaveBeenCalledTimes(1);
		expect(renameOrganization).toHaveBeenCalledWith('org-2', 'Acme Inc', ['vault']);
		expect(asMember.unwrapErr().kind).toBe('forbidden');
	});
});

describe('handleDeleteOrgRoute', () => {
	test('undoes every connection in it at its provider, then deletes it', async () => {
		const shared = {id: 'conn-1', integrationId: 'google', credential: 'enc:g'};
		const theirs = {id: 'conn-2', integrationId: 'email', credential: 'enc:m'};
		listOrgConnectionsWithCredential.mockResolvedValue(Ok([shared, theirs]));
		const order: string[] = [];
		beforeDisconnectAll.mockImplementation(async (connections: Array<{id: string}>) => {
			order.push(...connections.map((connection) => connection.id));
		});
		deleteOwnedOrganization.mockImplementation(async () => {
			order.push('org');
			return Ok(true);
		});

		const {handleDeleteOrgRoute} = await import('./route');
		const result = await handleDeleteOrgRoute(makeRequest());

		expect(result.isOk()).toBe(true);
		expect(listOrgConnectionsWithCredential).toHaveBeenCalledWith('org-2');
		expect(beforeDisconnectAll).toHaveBeenCalledWith([shared, theirs]);
		expect(order).toEqual(['conn-1', 'conn-2', 'org']);
		expect(deleteOwnedOrganization).toHaveBeenCalledWith({orgId: 'org-2', ownerUserId: 'user-1'});
	});

	test('not the last one the person owns, and only by its owner', async () => {
		listUserOrgs.mockResolvedValue(Ok([{...mine, role: 'member' as const}, acme]));
		const {handleDeleteOrgRoute} = await import('./route');
		const only = await handleDeleteOrgRoute(makeRequest());
		listUserOrgs.mockResolvedValue(Ok([mine, acme]));
		getMemberOrganization.mockResolvedValue(Ok(membership('member')));
		const asMember = await handleDeleteOrgRoute(makeRequest());

		expect(only.unwrapErr().kind).toBe('conflict');
		expect(asMember.unwrapErr().kind).toBe('forbidden');
		expect(deleteOwnedOrganization).not.toHaveBeenCalled();
		expect(beforeDisconnectAll).not.toHaveBeenCalled();
	});

	test('a conflict when it turned out to be the last one as it was deleted', async () => {
		listOrgConnectionsWithCredential.mockResolvedValue(Ok([]));
		deleteOwnedOrganization.mockResolvedValue(Ok(false));
		const {handleDeleteOrgRoute} = await import('./route');
		const result = await handleDeleteOrgRoute(makeRequest());

		expect(result.unwrapErr().kind).toBe('conflict');
	});
});

describe('handleLeaveOrgRoute', () => {
	test('undoes a member’s own connections there, then takes them out', async () => {
		getMemberOrganization.mockResolvedValue(Ok(membership('member')));
		const workMail = {id: 'conn-3', integrationId: 'email', credential: 'enc:m'};
		listOwnConnectionsWithCredential.mockResolvedValue(Ok([workMail]));

		const {handleLeaveOrgRoute} = await import('./route');
		const result = await handleLeaveOrgRoute(makeRequest());

		expect(result.isOk()).toBe(true);
		expect(listOwnConnectionsWithCredential).toHaveBeenCalledWith({orgId: 'org-2', userId: 'user-1'});
		expect(beforeDisconnectAll).toHaveBeenCalledWith([workMail]);
		expect(removeMembership).toHaveBeenCalledWith({orgId: 'org-2', userId: 'user-1', sharedAgentPasswordHash: expect.any(String)});
	});

	test('its owner stays, and deletes it instead', async () => {
		const {handleLeaveOrgRoute} = await import('./route');
		const owner = await handleLeaveOrgRoute(makeRequest());

		expect(owner.unwrapErr().kind).toBe('conflict');
		expect(removeMembership).not.toHaveBeenCalled();
	});
});

describe('handleListMembersRoute', () => {
	test('anyone in it sees its members and invitations', async () => {
		getMemberOrganization.mockResolvedValue(Ok(membership('member')));
		listInvitations.mockResolvedValue(Ok([{id: 'inv-1', email: 'sam@acme.com', invitedBy: 'Maya', expires: new Date('2026-10-21T00:00:00Z'), createdAt: new Date()}]));

		const {handleListMembersRoute} = await import('./route');
		const {members, invitations} = (await handleListMembersRoute(makeRequest())).unwrap();

		expect(members.map((one) => [one.userId, one.role])).toEqual([
			['user-1', 'owner'],
			['maya-1', 'member'],
			['jonas-1', 'member'],
		]);
		expect(invitations).toEqual([{id: 'inv-1', email: 'sam@acme.com', invitedBy: 'Maya', expiresAt: '2026-10-21T00:00:00.000Z'}]);
	});

	test('someone not in it sees nothing', async () => {
		getMemberOrganization.mockResolvedValue(Ok(null));
		const {handleListMembersRoute} = await import('./route');

		expect((await handleListMembersRoute(makeRequest())).unwrapErr().kind).toBe('not_found');
	});
});

describe('handleRemoveMemberRoute', () => {
	test('its owner removes a member, their own connections undone first', async () => {
		const theirs = {id: 'conn-4', integrationId: 'email', credential: 'enc:m'};
		listOwnConnectionsWithCredential.mockResolvedValue(Ok([theirs]));

		const {handleRemoveMemberRoute} = await import('./route');
		await handleRemoveMemberRoute(makeRequest({userId: 'maya-1'}));

		expect(listOwnConnectionsWithCredential).toHaveBeenCalledWith({orgId: 'org-2', userId: 'maya-1'});
		expect(beforeDisconnectAll).toHaveBeenCalledWith([theirs]);
		expect(removeMembership).toHaveBeenCalledWith({orgId: 'org-2', userId: 'maya-1', sharedAgentPasswordHash: expect.any(String)});
	});

	test('not its owner, not someone outside it, and not by a member', async () => {
		const {handleRemoveMemberRoute} = await import('./route');
		const self = await handleRemoveMemberRoute(makeRequest({userId: 'user-1'}));
		getMembership.mockResolvedValue(Ok(null));
		const outside = await handleRemoveMemberRoute(makeRequest({userId: 'sam-1'}));
		getMemberOrganization.mockResolvedValue(Ok(membership('member')));
		const asMember = await handleRemoveMemberRoute(makeRequest({userId: 'maya-1'}));

		expect(self.unwrapErr().kind).toBe('validation_error');
		expect(outside.unwrapErr().kind).toBe('not_found');
		expect(asMember.unwrapErr().kind).toBe('forbidden');
		expect(removeMembership).not.toHaveBeenCalled();
	});
});

describe('handleInviteRoute', () => {
	test('emails a link that works for a week, keeping only its token’s hash', async () => {
		const {handleInviteRoute} = await import('./route');
		const result = await handleInviteRoute(makeRequest({}, {email: ' Sam@Acme.com '}));

		const data = createInvitation.mock.calls[0]?.[0];
		expect(data).toMatchObject({orgId: 'org-2', email: 'sam@acme.com', invitedById: 'user-1'});
		expect(data.expires.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
		const sent = sendInvitation.mock.calls[0]?.[0];
		expect(sent).toMatchObject({email: 'sam@acme.com', orgName: 'Acme', invitedBy: 'Alex'});
		expect(sent.url).toStartWith('https://app.example.com/invite/');
		expect(data.tokenHash).toBe(`hashed:${sent.url.slice('https://app.example.com/invite/'.length)}`);
		expect(result.unwrap()).toMatchObject({id: 'inv-1', email: 'sam@acme.com', invitedBy: 'Alex'});
	});

	test('in development, or without RESEND_KEY, prints the link instead', async () => {
		env.NODE_ENV = 'development';
		const {handleInviteRoute} = await import('./route');
		await handleInviteRoute(makeRequest({}, {email: 'sam@acme.com'}));

		expect(sendInvitation).not.toHaveBeenCalled();
		expect(info.mock.calls[0]?.[0]).toContain('https://app.example.com/invite/');
	});

	test('refuses an address that can’t sign up here, someone already in it, and a member inviting', async () => {
		const {handleInviteRoute} = await import('./route');
		canSignUp.mockReturnValue(false);
		const notAllowed = await handleInviteRoute(makeRequest({}, {email: 'sam@elsewhere.com'}));
		canSignUp.mockReturnValue(true);
		const already = await handleInviteRoute(makeRequest({}, {email: 'maya-1@example.com'}));
		const notEmail = await handleInviteRoute(makeRequest({}, {email: 'sam'}));
		getMemberOrganization.mockResolvedValue(Ok(membership('member')));
		const asMember = await handleInviteRoute(makeRequest({}, {email: 'sam@acme.com'}));

		expect(notAllowed.unwrapErr().kind).toBe('validation_error');
		expect(already.unwrapErr().kind).toBe('conflict');
		expect(notEmail.unwrapErr().kind).toBe('validation_error');
		expect(asMember.unwrapErr().kind).toBe('forbidden');
		expect(createInvitation).not.toHaveBeenCalled();
	});

	test('someone who already has an account can be invited whatever ALLOWED_SIGNUP_EMAILS says', async () => {
		canSignUp.mockReturnValue(false);
		getUserByEmail.mockResolvedValue(Ok({id: 'sam-1', email: 'sam@elsewhere.com', name: 'Sam'}));
		const {handleInviteRoute} = await import('./route');

		expect((await handleInviteRoute(makeRequest({}, {email: 'sam@elsewhere.com'}))).isOk()).toBe(true);
	});
});

describe('handleRevokeInvitationRoute', () => {
	test('its owner takes an invitation back', async () => {
		const {handleRevokeInvitationRoute} = await import('./route');
		await handleRevokeInvitationRoute(makeRequest({invitationId: 'inv-1'}));
		deleteInvitation.mockResolvedValue(Ok(false));
		const gone = await handleRevokeInvitationRoute(makeRequest({invitationId: 'inv-9'}));

		expect(deleteInvitation).toHaveBeenCalledWith('org-2', 'inv-1');
		expect(gone.unwrapErr().kind).toBe('not_found');
	});
});
