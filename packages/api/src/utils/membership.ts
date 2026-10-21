import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getMembership, type OrgRole} from '@proxy/db/organization';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';

export type Member = {orgId: string; userId: string; role: OrgRole};

/** The signed-in user as a member of `orgId`, with their role; not found when they aren't one. */
export async function requireMemberOf(request: AuthenticatedRequest, orgId: string): Promise<Result<Member, ApiError>> {
	return Do(async ($) => {
		const membership = $(requirePresent($(await getMembership(request.user.userId, orgId)), ApiErr.notFound('organization', orgId)));
		return {orgId, userId: request.user.userId, role: membership.role};
	});
}

/** The signed-in user as the owner of `orgId`: only the owner may do this. */
export async function requireOwnerOf(request: AuthenticatedRequest, orgId: string): Promise<Result<Member, ApiError>> {
	return Do(async ($) => {
		const member = $(await requireMemberOf(request, orgId));
		if (member.role !== 'owner') {
			return $(Err(ApiErr.forbidden()));
		}
		return member;
	});
}
