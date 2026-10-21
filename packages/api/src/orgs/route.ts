import {randomBytes} from 'node:crypto';

import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {setSessionActiveOrg} from '@proxy/db/auth';
import {listConnectionsWithCredential} from '@proxy/db/connection';
import {createInvitation, deleteInvitation, listInvitations, type InvitationRow} from '@proxy/db/invitation';
import {
	createOrganization,
	deleteOrganization,
	getMembership,
	listMembers,
	listUserOrgs,
	removeMembership,
	renameOrganization,
	type MemberRow,
	type OrgRole,
	type UserOrgRow,
} from '@proxy/db/organization';
import {getUserByEmail} from '@proxy/db/user';

import {normalizeEmail} from '../auth/email-address';
import {sendInvitation} from '../auth/mail';
import {canSignUp, hashToken} from '../auth/session';
import {beforeDisconnect} from '../connections/disconnect';
import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {env} from '../utils/env';
import {requireMemberOf, requireOwnerOf} from '../utils/membership';
import {requireUserOrgId} from '../utils/user-org';

// Organizations and their members. Anyone in an organization sees its members and invitations;
// its one owner, whoever made it, renames and deletes it, invites people and removes members, and
// can't leave it; members can leave. Roles never change, and nobody deletes the last one they own,
// so everyone always owns one.

const MAX_NAME_LENGTH = 80;
// How long an invitation's link works.
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OrgResponse = {id: string; name: string; role: OrgRole; memberCount: number; invitationCount: number};

export type MemberResponse = {userId: string; name: string | null; email: string; image: string | null; role: OrgRole; joinedAt: string};

export type InvitationResponse = {id: string; email: string; invitedBy: string | null; expiresAt: string};

function toOrg(row: UserOrgRow): OrgResponse {
	return {id: row.id, name: row.name, role: row.role, memberCount: row.memberCount, invitationCount: row.invitationCount};
}

function toMember(row: MemberRow): MemberResponse {
	return {userId: row.userId, name: row.name, email: row.email, image: row.image, role: row.role, joinedAt: row.joinedAt.toISOString()};
}

function toInvitation(row: InvitationRow): InvitationResponse {
	return {id: row.id, email: row.email, invitedBy: row.invitedBy, expiresAt: row.expires.toISOString()};
}

function orgIdOf(request: AuthenticatedRequest): string {
	return request.params.orgId ?? '';
}

const nameBodySchema = z.object({name: z.string().trim().min(1, 'Give the organization a name').max(MAX_NAME_LENGTH, `The name can be at most ${MAX_NAME_LENGTH} characters`)});

/** `GET /api/orgs`: the person's organizations, the first one joined first, and the one open. */
export function handleListOrgsRoute(request: AuthenticatedRequest): Promise<Result<{orgs: OrgResponse[]; activeOrgId: string}, ApiError>> {
	return Do(async ($) => {
		const orgs = $(await listUserOrgs(request.user.userId)).map(toOrg);
		return {orgs, activeOrgId: $(await requireUserOrgId(request))};
	});
}

/** `POST /api/orgs` with `{name}`: a new organization, the person its owner, opened in the switcher. */
export function handleCreateOrgRoute(request: AuthenticatedRequest): Promise<Result<OrgResponse, ApiError>> {
	return Do(async ($) => {
		const {name} = $(parseSchema(nameBodySchema, request.body));
		const org = $(await createOrganization({userId: request.user.userId, name}));
		$(await setSessionActiveOrg(request.user.sessionTokenHash, org.id));
		return {id: org.id, name: org.name, role: 'owner' as const, memberCount: 1, invitationCount: 0};
	});
}

/** `POST /api/me/active-org` with `{orgId}`: opens one of the person's organizations in the switcher. */
export function handleSetActiveOrgRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(parseSchema(z.object({orgId: z.string().min(1)}), request.body));
		$(await requireMemberOf(request, orgId));
		$(await setSessionActiveOrg(request.user.sessionTokenHash, orgId));
	});
}

/** `PATCH /api/orgs/:orgId` with `{name}`: its owner renames it, for everyone in it. */
export function handleRenameOrgRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(await requireOwnerOf(request, orgIdOf(request)));
		const {name} = $(parseSchema(nameBodySchema, request.body));
		$(await renameOrganization(orgId, name));
	});
}

/**
 * `DELETE /api/orgs/:orgId`: its owner deletes it, unless it is the last one they own. Every
 * connection in it is undone at its provider first, as disconnecting does; a provider that can't
 * be reached doesn't stop it.
 */
export function handleDeleteOrgRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId} = $(await requireOwnerOf(request, orgIdOf(request)));
		const owned = $(await listUserOrgs(userId)).filter((org) => org.role === 'owner');
		if (owned.length <= 1) {
			return $(Err(ApiErr.conflict('This is the only organization you own. Create another first, or delete your account instead.')));
		}
		const connections = $(await listConnectionsWithCredential(orgId));
		for (const connection of connections) {
			await beforeDisconnect(connection);
		}
		$(await deleteOrganization(orgId));
		log.info('Deleted an organization', {orgId, connections: connections.length});
	});
}

/** `POST /api/orgs/:orgId/leave`: a member leaves it; its owner deletes it instead. */
export function handleLeaveOrgRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId, role} = $(await requireMemberOf(request, orgIdOf(request)));
		if (role === 'owner') {
			return $(Err(ApiErr.conflict('You own this organization, so it can’t be left. Delete it instead.')));
		}
		$(await removeMembership({orgId, userId}));
	});
}

/** `GET /api/orgs/:orgId/members`: who is in it and who is invited, for anyone in it. */
export function handleListMembersRoute(request: AuthenticatedRequest): Promise<Result<{members: MemberResponse[]; invitations: InvitationResponse[]}, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(await requireMemberOf(request, orgIdOf(request)));
		const members = $(await listMembers(orgId)).map(toMember);
		const invitations = $(await listInvitations(orgId)).map(toInvitation);
		return {members, invitations};
	});
}

/** `DELETE /api/orgs/:orgId/members/:userId`: the owner removes a member. */
export function handleRemoveMemberRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId: self} = $(await requireOwnerOf(request, orgIdOf(request)));
		const userId = request.params.userId ?? '';
		if (userId === self) {
			return $(Err(ApiErr.validationError('You own this organization. Delete it instead.')));
		}
		$(requirePresent($(await getMembership(userId, orgId)), ApiErr.notFound('member', userId)));
		$(await removeMembership({orgId, userId}));
	});
}

/**
 * `POST /api/orgs/:orgId/invitations` with `{email}`: its owner invites someone by address. The link
 * is emailed, or printed in the api's log in development or without RESEND_KEY, as sign-in links
 * are; it works for a week. An address that can't sign up here, by ALLOWED_SIGNUP_EMAILS, is
 * refused, and so is someone already in it.
 */
export function handleInviteRoute(request: AuthenticatedRequest): Promise<Result<InvitationResponse, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId} = $(await requireOwnerOf(request, orgIdOf(request)));
		const {email: given} = $(parseSchema(z.object({email: z.string()}), request.body));
		const email = $(requirePresent(normalizeEmail(given), ApiErr.validationError('That isn’t an email address')));
		const existing = $(await getUserByEmail(email));
		if (!existing && !canSignUp(email)) {
			return $(Err(ApiErr.validationError('This address can’t sign up to this Personal Agent Proxy.')));
		}
		const members = $(await listMembers(orgId));
		if (members.some((member) => member.email === email)) {
			return $(Err(ApiErr.conflict(`${email} is already in this organization`)));
		}
		const appUrl = $(requirePresent(env.APP_URL, ApiErr.internalError(new Error('APP_URL is not configured'))));
		const token = randomBytes(32).toString('base64url');
		const invitation = $(await createInvitation({orgId, email, tokenHash: hashToken(token), invitedById: userId, expires: new Date(Date.now() + INVITATION_TTL_MS)}));
		const url = `${appUrl}/invite/${token}`;
		const orgName = $(await listUserOrgs(userId)).find((org) => org.id === orgId)?.name ?? 'an organization';
		const invitedBy = request.user.name ?? request.user.email;
		// Without a way to send email, whoever runs Personal Agent Proxy can read the link from its log.
		if (env.NODE_ENV === 'development' || !env.RESEND_KEY) {
			log.info(`[Invitation] ${email} to ${orgName}: ${url}`);
			return toInvitation(invitation);
		}
		$(await sendInvitation({email, url, orgName, invitedBy}));
		return toInvitation(invitation);
	});
}

/** `DELETE /api/orgs/:orgId/invitations/:invitationId`: its owner takes an invitation back; its link stops working. */
export function handleRevokeInvitationRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(await requireOwnerOf(request, orgIdOf(request)));
		const invitationId = request.params.invitationId ?? '';
		if (!$(await deleteInvitation(orgId, invitationId))) {
			return $(Err(ApiErr.notFound('invitation', invitationId)));
		}
	});
}
