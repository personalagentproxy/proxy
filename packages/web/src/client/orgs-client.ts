import {
	acceptedInvitationSchema,
	invitationLinkSchema,
	invitationSchema,
	type inviteBodySchema,
	memberListSchema,
	orgListSchema,
	type orgNameBodySchema,
	orgSchema,
} from '@proxy/contracts/orgs';
import type {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// Organizations and their members: the switcher's list, Members, Settings and invitations. An
// organization is named by its slug, its address in the app and on the api.

/** The person's organizations, the first one joined first. */
export function listOrgs() {
	return apiRequest('GET', '/api/orgs', orgListSchema);
}

/** The organization at a slug, for a member of it: 404 for any other. */
export function getOrg(org: string) {
	return apiRequest('GET', orgApi(org), orgSchema);
}

/** A new organization, the person its owner, with the slug its address is. */
export function createOrg(name: string) {
	return apiRequest('POST', '/api/orgs', orgSchema, {
		name,
	} satisfies z.input<typeof orgNameBodySchema>);
}

/** The welcome flow is done, or skipped: the organization opens on the app from now on. */
export function finishOnboarding(org: string) {
	return apiSend('POST', `${orgApi(org)}/onboarded`);
}

export function renameOrg(org: string, name: string) {
	return apiSend('PATCH', orgApi(org), {name} satisfies z.input<typeof orgNameBodySchema>);
}

/** Its owner deletes it, every connection in it undone at its provider first. */
export function deleteOrg(org: string) {
	return apiSend('DELETE', orgApi(org));
}

export function leaveOrg(org: string) {
	return apiSend('POST', `${orgApi(org)}/leave`);
}

export function listMembers(org: string) {
	return apiRequest('GET', `${orgApi(org)}/members`, memberListSchema);
}

export function removeMember(org: string, userId: string) {
	return apiSend('DELETE', `${orgApi(org)}/members/${userId}`);
}

/** Emails an invitation, or prints its link in the api's log in development. */
export function inviteMember(org: string, email: string) {
	return apiRequest('POST', `${orgApi(org)}/invitations`, invitationSchema, {
		email,
	} satisfies z.input<typeof inviteBodySchema>);
}

export function revokeInvitation(org: string, invitationId: string) {
	return apiSend('DELETE', `${orgApi(org)}/invitations/${invitationId}`);
}

/** What an invitation's link is for; 404 for none, taken up or taken back. */
export function getInvitation(token: string) {
	return apiRequest('GET', `/api/invitations/${encodeURIComponent(token)}`, invitationLinkSchema);
}

/** Takes it up at the address it was sent to, answering with where to go: 403 for another address. */
export function acceptInvitation(token: string) {
	return apiRequest(
		'POST',
		`/api/invitations/${encodeURIComponent(token)}/accept`,
		acceptedInvitationSchema,
	);
}
