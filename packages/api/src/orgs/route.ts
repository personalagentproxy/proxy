import {randomBytes} from 'node:crypto';

import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, type Experiment, parseSchema, requirePresent} from '@proxy/utils';
import {type Invitation, inviteBodySchema, type Member, type memberListSchema, type Org, type orgListSchema, orgNameBodySchema} from '@proxy/contracts/orgs';
import {listOrgConnectionsWithCredential, listOwnConnectionsWithCredential} from '@proxy/db/connection';
import {createInvitation, deleteInvitation, listInvitations, type InvitationRow} from '@proxy/db/invitation';
import {
	deleteOwnedOrganization,
	getMembership,
	listMembers,
	listUserOrgs,
	markOrganizationOnboarded,
	removeMembership,
	renameOrganization,
	type MemberRow,
	type UserOrgRow,
} from '@proxy/db/organization';
import {getUserByEmail} from '@proxy/db/user';

import {normalizeEmail} from '../auth/email-address';
import {sendInvitation} from '../auth/mail';
import {canSignUp, hashToken} from '../auth/session';
import {beforeDisconnectAll} from '../connections/disconnect';
import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {env} from '../utils/env';
import {requireOwner, requireViewer} from '../utils/user-org';
import {unknownPasswordHash} from '../agents/unknown-password';
import {createOrganization} from './provision';
import {NAMED_AFTER_ORGANIZATION} from './starter-connections';

// Organizations and their members, each organization named in the address by its slug
// (`/api/orgs/:org/…`). Anyone in an organization sees its members and invitations; its one owner,
// whoever made it, renames and deletes it, invites people and removes members, and can't leave it;
// members can leave. Roles never change, and nobody deletes the last one they own, so everyone
// always owns one.

// How long an invitation's link works.
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toOrg(row: UserOrgRow, experiments: Experiment[]): Org {
	return {id: row.id, slug: row.slug, name: row.name, role: row.role, onboarded: row.onboarded, experiments, memberCount: row.memberCount, invitationCount: row.invitationCount};
}

function toMember(row: MemberRow): Member {
	return {userId: row.userId, name: row.name, email: row.email, image: row.image, role: row.role, joinedAt: row.joinedAt.toISOString()};
}

function toInvitation(row: InvitationRow): Invitation {
	return {id: row.id, email: row.email, invitedBy: row.invitedBy, expiresAt: row.expires.toISOString()};
}

/**
 * `GET /api/orgs`: the person's organizations, the first one joined first, for the switcher and
 * for where the app opens with no organization in its address. The experiments are each
 * organization's own page's to say (`GET /api/orgs/:org`); here they are left empty.
 */
export function handleListOrgsRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof orgListSchema>, ApiError>> {
	return Do(async ($) => {
		return {orgs: $(await listUserOrgs(request.user.userId)).map((org) => toOrg(org, []))};
	});
}

/** `GET /api/orgs/:org`: the organization the address names, for a member of it, with their role there. */
export function handleGetOrgRoute(request: AuthenticatedRequest): Promise<Result<Org, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const row = $(
			requirePresent(
				$(await listUserOrgs(viewer.userId)).find((org) => org.id === viewer.orgId),
				ApiErr.notFound('organization', viewer.slug),
			),
		);
		return toOrg(row, viewer.experiments);
	});
}

/** `POST /api/orgs` with `{name}`: a new organization, the person its owner, answered with the slug its address is. */
export function handleCreateOrgRoute(request: AuthenticatedRequest): Promise<Result<Org, ApiError>> {
	return Do(async ($) => {
		const {name} = $(parseSchema(orgNameBodySchema, request.body));
		const org = $(await createOrganization({userId: request.user.userId, name}));
		return {id: org.id, slug: org.slug, name: org.name, role: 'owner' as const, onboarded: true, experiments: [], memberCount: 1, invitationCount: 0};
	});
}

/** `POST /api/orgs/:org/onboarded` — the welcome flow is done, or skipped; it is not shown again. */
export function handleFinishOnboardingRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		$(await markOrganizationOnboarded(viewer.orgId));
	});
}

/** `PATCH /api/orgs/:org` with `{name}`: its owner renames it, for everyone in it. */
export function handleRenameOrgRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(await requireOwner(request));
		const {name} = $(parseSchema(orgNameBodySchema, request.body));
		$(await renameOrganization(orgId, name, NAMED_AFTER_ORGANIZATION));
	});
}

/**
 * `DELETE /api/orgs/:org`: its owner deletes it, unless it is the last one they own. Every
 * connection in it, shared or a member's own, is undone at its provider first, as disconnecting
 * does; a provider that can't be reached doesn't stop it.
 */
export function handleDeleteOrgRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId} = $(await requireOwner(request));
		const lastOwned = ApiErr.conflict('This is the only organization you own. Create another first, or delete your account instead.');
		const owned = $(await listUserOrgs(userId)).filter((org) => org.role === 'owner');
		if (owned.length <= 1) {
			return $(Err(lastOwned));
		}
		const connections = $(await listOrgConnectionsWithCredential(orgId));
		await beforeDisconnectAll(connections);
		// Checked again as it is deleted: another deletion may have taken the one that stays.
		if (!$(await deleteOwnedOrganization({orgId, ownerUserId: userId}))) {
			return $(Err(lastOwned));
		}
		log.info('Deleted an organization', {orgId, connections: connections.length});
	});
}

/**
 * Takes a member out: their own connections there are undone at their providers and deleted, and
 * so are their own agents and the MCP clients they signed in as a shared agent; the shared
 * connections and agents stay. The caller has checked they aren't its owner.
 */
function takeOut(orgId: string, userId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		await beforeDisconnectAll($(await listOwnConnectionsWithCredential({orgId, userId})));
		$(await removeMembership({orgId, userId, sharedAgentPasswordHash: await unknownPasswordHash()}));
	});
}

/** `POST /api/orgs/:org/leave`: a member leaves it; its owner deletes it instead. */
export function handleLeaveOrgRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId, role} = $(await requireViewer(request));
		if (role === 'owner') {
			return $(Err(ApiErr.conflict('You own this organization, so it can’t be left. Delete it instead.')));
		}
		$(await takeOut(orgId, userId));
	});
}

/** `GET /api/orgs/:org/members`: who is in it and who is invited, for anyone in it. */
export function handleListMembersRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof memberListSchema>, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(await requireViewer(request));
		const members = $(await listMembers(orgId)).map(toMember);
		const invitations = $(await listInvitations(orgId)).map(toInvitation);
		return {members, invitations};
	});
}

/** `DELETE /api/orgs/:org/members/:userId`: the owner removes a member. */
export function handleRemoveMemberRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId: self} = $(await requireOwner(request));
		const userId = request.params.userId ?? '';
		if (userId === self) {
			return $(Err(ApiErr.validationError('You own this organization. Delete it instead.')));
		}
		$(requirePresent($(await getMembership(userId, orgId)), ApiErr.notFound('member', userId)));
		$(await takeOut(orgId, userId));
	});
}

/**
 * `POST /api/orgs/:org/invitations` with `{email}`: its owner invites someone by address. The link
 * is emailed, or printed in the api's log in development or without RESEND_KEY, as sign-in links
 * are; it works for a week. An address that can't sign up here, by ALLOWED_SIGNUP_EMAILS, is
 * refused, and so is someone already in it.
 */
export function handleInviteRoute(request: AuthenticatedRequest): Promise<Result<Invitation, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(request));
		const {orgId, userId} = viewer;
		const {email: given} = $(parseSchema(inviteBodySchema, request.body));
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
		const orgName = viewer.name;
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

/** `DELETE /api/orgs/:org/invitations/:invitationId`: its owner takes an invitation back; its link stops working. */
export function handleRevokeInvitationRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(await requireOwner(request));
		const invitationId = request.params.invitationId ?? '';
		if (!$(await deleteInvitation(orgId, invitationId))) {
			return $(Err(ApiErr.notFound('invitation', invitationId)));
		}
	});
}
