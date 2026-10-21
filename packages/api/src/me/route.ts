import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, type Experiment, requirePresent} from '@proxy/utils';
import {listConnectionsWithCredential} from '@proxy/db/connection';
import {getUserOrganization, listUserOrgs, markOrganizationOnboarded, type OrgRole, removeMembership} from '@proxy/db/organization';
import {deleteUser, getUserFromId} from '@proxy/db/user';

import {clearSessionCookie} from '../auth/session';
import {beforeDisconnect} from '../connections/disconnect';
import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {sendApiError} from '../server/response';

export type MeResponse = {
	user: {id: string; email: string; name: string | null; image: string | null};
	// The organization the human side works in, open in the switcher, and the person's role there.
	org: {id: string; name: string; role: OrgRole};
	/** False until the welcome flow is finished or skipped; the web app shows it instead of the app until then. */
	onboarded: boolean;
	/** The experiments on for the organization, for the web app's `useExperiment`. */
	experiments: Experiment[];
};

/**
 * Who is signed in, and the organization they work in. The web app's guard: 401 means "send them
 * to /login". Everyone owns an organization from sign-up until their account is deleted.
 */
export function handleMeRoute(request: AuthenticatedRequest): Promise<Result<MeResponse, ApiError>> {
	return Do(async ($) => {
		const user = $(await getUserFromId(request.user.userId));
		if (!user) {
			// The session row points at a deleted user — treat as signed out.
			return $(Err(ApiErr.unauthenticated()));
		}
		const organization = $(requirePresent($(await getUserOrganization(user.id, request.user.activeOrgId)), ApiErr.unauthenticated()));

		return {
			user: {id: user.id, email: user.email, name: user.name, image: user.image},
			org: {id: organization.id, name: organization.name, role: organization.role},
			onboarded: organization.onboardedAt !== null,
			experiments: request.user.experiments,
		};
	});
}

/** `POST /api/me/onboarded` — the welcome flow is done, or skipped; it is not shown again. */
export function handleFinishOnboardingRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const organization = $(requirePresent($(await getUserOrganization(request.user.userId, request.user.activeOrgId)), ApiErr.unauthenticated()));
		$(await markOrganizationOnboarded(organization.id));
	});
}

/**
 * Deletes the signed-in person's account. The organizations they own are deleted with everything
 * in them, their other members losing them; they leave the others. Every connection in an
 * organization deleted is undone at its provider first, as disconnecting it does (Google's grant
 * revoked, a bank's login removed at Plaid); a provider that can't be reached doesn't stop the
 * deletion, and is logged, as disconnecting logs it. Then the user goes, with their agents, their
 * logins and MCP clients, and the activity log.
 */
function deleteAccount(userId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		let undone = 0;
		for (const org of $(await listUserOrgs(userId))) {
			if (org.role !== 'owner') {
				$(await removeMembership({orgId: org.id, userId}));
				continue;
			}
			const connections = $(await listConnectionsWithCredential(org.id));
			for (const connection of connections) {
				await beforeDisconnect(connection);
			}
			undone += connections.length;
		}
		$(await deleteUser(userId));
		log.info('Deleted an account', {userId, connections: undone});
	});
}

/** `DELETE /api/me` — deletes the account and signs out: the session went with the user, and its cookie goes now. */
export async function handleDeleteMeRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	const deleted = await deleteAccount(request.user.userId);
	if (deleted.isErr()) {
		sendApiError(res, deleted.error);
		return;
	}
	clearSessionCookie(res);
	res.status(204).end();
}
