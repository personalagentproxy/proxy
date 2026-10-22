import {isExperiment} from '@proxy/utils';
import {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// Organizations and their members: the switcher's list, Members, Settings and invitations. An
// organization is named by its slug, its address in the app and on the api.

export const orgSchema = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	role: z.enum(['owner', 'member']),
	// False until the welcome flow is finished or skipped; the human side shows it until then.
	onboarded: z.boolean(),
	// The experiments on for it; read them with useExperiments.
	experiments: z.array(z.string()).transform((ids) => ids.filter(isExperiment)),
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

/** The person's organizations, the first one joined first. */
export function listOrgs() {
	return apiRequest('GET', '/api/orgs', z.object({orgs: z.array(orgSchema)}));
}

/** The organization at a slug, for a member of it: 404 for any other. */
export function getOrg(org: string) {
	return apiRequest('GET', orgApi(org), orgSchema);
}

/** A new organization, the person its owner, with the slug its address is. */
export function createOrg(name: string) {
	return apiRequest('POST', '/api/orgs', orgSchema, {name});
}

/** The welcome flow is done, or skipped: the organization opens on the app from now on. */
export function finishOnboarding(org: string) {
	return apiSend('POST', `${orgApi(org)}/onboarded`);
}

export function renameOrg(org: string, name: string) {
	return apiSend('PATCH', orgApi(org), {name});
}

/** Its owner deletes it, every connection in it undone at its provider first. */
export function deleteOrg(org: string) {
	return apiSend('DELETE', orgApi(org));
}

export function leaveOrg(org: string) {
	return apiSend('POST', `${orgApi(org)}/leave`);
}

export function listMembers(org: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/members`,
		z.object({members: z.array(memberSchema), invitations: z.array(invitationSchema)}),
	);
}

export function removeMember(org: string, userId: string) {
	return apiSend('DELETE', `${orgApi(org)}/members/${userId}`);
}

/** Emails an invitation, or prints its link in the api's log in development. */
export function inviteMember(org: string, email: string) {
	return apiRequest('POST', `${orgApi(org)}/invitations`, invitationSchema, {email});
}

export function revokeInvitation(org: string, invitationId: string) {
	return apiSend('DELETE', `${orgApi(org)}/invitations/${invitationId}`);
}

const invitationLinkSchema = z.object({
	orgId: z.string(),
	orgSlug: z.string(),
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

/** Takes it up at the address it was sent to, answering with where to go: 403 for another address. */
export function acceptInvitation(token: string) {
	return apiRequest(
		'POST',
		`/api/invitations/${encodeURIComponent(token)}/accept`,
		z.object({orgId: z.string(), orgSlug: z.string()}),
	);
}
