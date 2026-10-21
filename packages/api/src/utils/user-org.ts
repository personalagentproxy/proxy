import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {MemberViewer} from '@proxy/db/connection';
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

/**
 * The signed-in user in the organization they work in: what they see there is its shared
 * connections and their own.
 */
export async function requireViewer(request: AuthenticatedRequest): Promise<Result<MemberViewer, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		return {orgId, userId: request.user.userId};
	});
}
