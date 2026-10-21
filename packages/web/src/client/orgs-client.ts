import {z} from 'zod';
import {apiRequest, apiSend} from '@/client/request';

// Organizations and their members: the switcher's list, Members, Settings and invitations.

export const orgSchema = z.object({
	id: z.string(),
	name: z.string(),
	role: z.enum(['owner', 'member']),
	memberCount: z.number(),
	// Invitations not taken up yet.
	invitationCount: z.number(),
});

export type Org = z.infer<typeof orgSchema>;

const memberSchema = z.object({
	userId: z.string(),
	name: z.string().nullable(),
	email: z.string(),
	image: z.string().nullable(),
	role: z.enum(['owner', 'member']),
	joinedAt: z.string(),
});

export type Member = z.infer<typeof memberSchema>;

const invitationSchema = z.object({
	id: z.string(),
	email: z.string(),
	invitedBy: z.string().nullable(),
	expiresAt: z.string(),
});

export type Invitation = z.infer<typeof invitationSchema>;

/** The person's organizations, the first one joined first, and the one open in the switcher. */
export function listOrgs() {
	return apiRequest(
		'GET',
		'/api/orgs',
		z.object({orgs: z.array(orgSchema), activeOrgId: z.string()}),
	);
}

/** A new organization, the person its owner; it opens in the switcher. */
export function createOrg(name: string) {
	return apiRequest('POST', '/api/orgs', orgSchema, {name});
}

/** Opens one of the person's organizations in the switcher. */
export function setActiveOrg(orgId: string) {
	return apiSend('POST', '/api/me/active-org', {orgId});
}

export function renameOrg(orgId: string, name: string) {
	return apiSend('PATCH', `/api/orgs/${orgId}`, {name});
}

/** Its owner deletes it, every connection in it undone at its provider first. */
export function deleteOrg(orgId: string) {
	return apiSend('DELETE', `/api/orgs/${orgId}`);
}

export function leaveOrg(orgId: string) {
	return apiSend('POST', `/api/orgs/${orgId}/leave`);
}

export function listMembers(orgId: string) {
	return apiRequest(
		'GET',
		`/api/orgs/${orgId}/members`,
		z.object({members: z.array(memberSchema), invitations: z.array(invitationSchema)}),
	);
}

export function removeMember(orgId: string, userId: string) {
	return apiSend('DELETE', `/api/orgs/${orgId}/members/${userId}`);
}

/** Emails an invitation, or prints its link in the api's log in development. */
export function inviteMember(orgId: string, email: string) {
	return apiRequest('POST', `/api/orgs/${orgId}/invitations`, invitationSchema, {email});
}

export function revokeInvitation(orgId: string, invitationId: string) {
	return apiSend('DELETE', `/api/orgs/${orgId}/invitations/${invitationId}`);
}

const invitationLinkSchema = z.object({
	orgId: z.string(),
	orgName: z.string(),
	invitedBy: z.string().nullable(),
	email: z.string(),
	expired: z.boolean(),
	member: z.boolean(),
});

export type InvitationLink = z.infer<typeof invitationLinkSchema>;

/** What an invitation's link is for; 404 for none, taken up or taken back. */
export function getInvitation(token: string) {
	return apiRequest('GET', `/api/invitations/${encodeURIComponent(token)}`, invitationLinkSchema);
}

/** Takes it up at the address it was sent to: 403 for another address. */
export function acceptInvitation(token: string) {
	return apiRequest(
		'POST',
		`/api/invitations/${encodeURIComponent(token)}/accept`,
		z.object({orgId: z.string()}),
	);
}
