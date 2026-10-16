import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, type Experiment, requirePresent} from '@proxy/utils';
import {listConnectionsWithCredential} from '@proxy/db/connection';
import {getUserOrganization, markOrganizationOnboarded} from '@proxy/db/organization';
import {deleteUser, getUserFromId} from '@proxy/db/user';

import {clearSessionCookie} from '../auth/session';
import {beforeDisconnect} from '../connections/disconnect';
import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {sendApiError} from '../server/response';

export type MeResponse = {
	user: {id: string; email: string; name: string | null; image: string | null};
	/** False until the welcome flow is finished or skipped; the web app shows it instead of the app until then. */
	onboarded: boolean;
	/** The experiments on for the organization, for the web app's `useExperiment`. */
	experiments: Experiment[];
};

/** Who is signed in. The web app's guard: 401 means "send them to /login". */
export function handleMeRoute(request: AuthenticatedRequest): Promise<Result<MeResponse, ApiError>> {
	return Do(async ($) => {
		const user = $(await getUserFromId(request.user.userId));
		if (!user) {
			// The session row points at a deleted user — treat as signed out.
			return $(Err(ApiErr.unauthenticated()));
		}
		const organization = $(requirePresent($(await getUserOrganization(user.id)), ApiErr.unauthenticated()));

		return {
			user: {id: user.id, email: user.email, name: user.name, image: user.image},
			onboarded: organization.onboardedAt !== null,
			experiments: request.user.experiments,
		};
	});
}

/** `POST /api/me/onboarded` — the welcome flow is done, or skipped; it is not shown again. */
export function handleFinishOnboardingRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const organization = $(requirePresent($(await getUserOrganization(request.user.userId)), ApiErr.unauthenticated()));
		$(await markOrganizationOnboarded(organization.id));
	});
}

/**
 * Deletes the signed-in person's account: each connection is undone at its provider first, as
 * disconnecting it does (Google's grant revoked, a bank's login removed at Plaid), then the user
 * and their organization, with its connections, information, agents, their logins and MCP
 * clients, and the activity log. A provider that can't be reached doesn't stop the deletion; it is
 * logged, as disconnecting logs it.
 */
function deleteAccount(userId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const organization = $(await getUserOrganization(userId));
		const connections = organization ? $(await listConnectionsWithCredential(organization.id)) : [];
		for (const connection of connections) {
			await beforeDisconnect(connection);
		}
		$(await deleteUser(userId));
		log.info('Deleted an account', {userId, connections: connections.length});
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
