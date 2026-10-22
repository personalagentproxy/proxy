import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {listOrgConnectionsWithCredential, listOwnConnectionsWithCredential} from '@proxy/db/connection';
import {listUserOrgs, removeMembership} from '@proxy/db/organization';
import {deleteUser, getUserFromId} from '@proxy/db/user';

import {clearSessionCookie} from '../auth/session';
import {beforeDisconnect} from '../connections/disconnect';
import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {sendApiError} from '../server/response';

export type MeResponse = {
	user: {id: string; email: string; name: string | null; image: string | null};
};

/** Who is signed in. The web app's guard: 401 means "send them to /login". The organizations they are in are `GET /api/orgs`. */
export function handleMeRoute(request: AuthenticatedRequest): Promise<Result<MeResponse, ApiError>> {
	return Do(async ($) => {
		const user = $(await getUserFromId(request.user.userId));
		if (!user) {
			// The session row points at a deleted user — treat as signed out.
			return $(Err(ApiErr.unauthenticated()));
		}

		return {user: {id: user.id, email: user.email, name: user.name, image: user.image}};
	});
}

/**
 * Deletes the signed-in person's account. The organizations they own are deleted with everything
 * in them, their other members losing them; they leave the others, their own connections there
 * going, the shared ones staying. Every connection deleted is undone at its provider first, as
 * disconnecting it does (Google's grant revoked, a bank's login removed at Plaid); a provider that
 * can't be reached doesn't stop the deletion, and is logged, as disconnecting logs it. Then the
 * user goes, with their agents, their logins and MCP clients, and the activity log.
 */
function deleteAccount(userId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		let undone = 0;
		for (const org of $(await listUserOrgs(userId))) {
			const owned = org.role === 'owner';
			const connections = owned ? $(await listOrgConnectionsWithCredential(org.id)) : $(await listOwnConnectionsWithCredential({orgId: org.id, userId}));
			for (const connection of connections) {
				await beforeDisconnect(connection);
			}
			undone += connections.length;
			if (!owned) {
				$(await removeMembership({orgId: org.id, userId}));
			}
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
