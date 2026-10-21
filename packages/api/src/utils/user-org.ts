import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getUserOrgId} from '@proxy/db/organization';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';

/**
 * The organization the signed-in user works in: the one their session has open in the switcher,
 * while they are a member of it, else the first one they joined. A user in none is signed out.
 */
export async function requireUserOrgId(request: AuthenticatedRequest): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await getUserOrgId(request.user.userId, request.user.activeOrgId));
		return $(requirePresent(orgId, ApiErr.unauthenticated()));
	});
}
