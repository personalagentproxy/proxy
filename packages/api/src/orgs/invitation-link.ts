import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {setSessionActiveOrg} from '@proxy/db/auth';
import {acceptInvitation, getInvitationByTokenHash, type InvitationForLink} from '@proxy/db/invitation';
import {getMembership} from '@proxy/db/organization';

import {hashToken} from '../auth/session';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';

// An invitation's link, `/invite/<token>` in the web app, signed in: what it is for, and taking it
// up. Only the address it was sent to can take it up, within the week it works.

export type InvitationLinkResponse = {
	orgId: string;
	orgName: string;
	invitedBy: string | null;
	// The address it was sent to.
	email: string;
	expired: boolean;
	// Whether the signed-in person is in the organization already.
	member: boolean;
};

function requireInvitation(request: AuthenticatedRequest): Promise<Result<InvitationForLink, ApiError>> {
	return Do(async ($) => {
		const token = request.params.token ?? '';
		return $(requirePresent($(await getInvitationByTokenHash(hashToken(token))), ApiErr.notFound('invitation')));
	});
}

/**
 * `GET /api/invitations/:token`: the organization it is for, who sent it and to whom. Nothing in
 * the organization shows until the invitation is taken up, by its address alone.
 */
export function handleGetInvitationRoute(request: AuthenticatedRequest): Promise<Result<InvitationLinkResponse, ApiError>> {
	return Do(async ($) => {
		const invitation = $(await requireInvitation(request));
		const member = $(await getMembership(request.user.userId, invitation.org.id)) !== null;
		return {
			orgId: invitation.org.id,
			orgName: invitation.org.name,
			invitedBy: invitation.invitedBy,
			email: invitation.email,
			expired: invitation.expires <= new Date(),
			member,
		};
	});
}

/**
 * `POST /api/invitations/:token/accept`: the signed-in person, at the address it was sent to,
 * becomes a member, with their own vault there, and the organization opens in their switcher.
 */
export function handleAcceptInvitationRoute(request: AuthenticatedRequest): Promise<Result<{orgId: string}, ApiError>> {
	return Do(async ($) => {
		const invitation = $(await requireInvitation(request));
		if (invitation.expires <= new Date()) {
			return $(Err(ApiErr.validationError('This invitation has expired. Ask for a new one.')));
		}
		if (invitation.email.toLowerCase() !== request.user.email.toLowerCase()) {
			return $(Err(ApiErr.forbidden()));
		}
		$(await acceptInvitation({invitationId: invitation.id, orgId: invitation.org.id, userId: request.user.userId, vaultName: invitation.org.name}));
		$(await setSessionActiveOrg(request.user.sessionTokenHash, invitation.org.id));
		return {orgId: invitation.org.id};
	});
}
