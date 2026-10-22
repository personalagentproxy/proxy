import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent, type Experiment} from '@proxy/utils';
import {getMemberOrganization, type OrgRole} from '@proxy/db/organization';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';

/**
 * The signed-in user in the organization a request is about, named by its slug in the address
 * (`/api/orgs/:org/…`): what they see there is its shared connections and agents and their own,
 * their role says what they may change, and the experiments are the organization's. One they
 * aren't a member of is not found, as is one that doesn't exist.
 */
export type OrgViewer = {orgId: string; userId: string; slug: string; name: string; role: OrgRole; onboarded: boolean; experiments: Experiment[]};

export async function requireViewer(request: AuthenticatedRequest): Promise<Result<OrgViewer, ApiError>> {
	return Do(async ($) => {
		const slug = request.params.org ?? '';
		const org = $(requirePresent($(await getMemberOrganization(request.user.userId, slug)), ApiErr.notFound('organization', slug)));
		return {orgId: org.id, userId: request.user.userId, slug: org.slug, name: org.name, role: org.role, onboarded: org.onboardedAt !== null, experiments: org.experiments};
	});
}

/** The signed-in user as the owner of the organization in the address: only the owner may do this. */
export async function requireOwner(request: AuthenticatedRequest): Promise<Result<OrgViewer, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		if (viewer.role !== 'owner') {
			return $(Err(ApiErr.forbidden()));
		}
		return viewer;
	});
}
