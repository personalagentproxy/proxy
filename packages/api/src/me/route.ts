import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {getUserFromId} from '@proxy/db/user';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';

export type MeResponse = {
	user: {id: string; email: string; name: string | null; image: string | null};
};

/** Who is signed in. The web app's guard: 401 means "send them to /login". */
export function handleMeRoute(request: AuthenticatedRequest): Promise<Result<MeResponse, ApiError>> {
	return Do(async ($) => {
		const user = $(await getUserFromId(request.user.userId));
		if (!user) {
			// The session row points at a deleted user — treat as signed out.
			return $(Err(ApiErr.unauthenticated()));
		}

		return {
			user: {id: user.id, email: user.email, name: user.name, image: user.image},
		};
	});
}
