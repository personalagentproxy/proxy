import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getUserOrgId} from '@proxy/db/organization';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';

/** The signed-in user's organization; a user without one has been deleted. */
export async function requireUserOrgId(request: AuthenticatedRequest): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await getUserOrgId(request.user.userId));
		return $(requirePresent(orgId, ApiErr.unauthenticated()));
	});
}
