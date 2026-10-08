import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getUserOrganization, markOrganizationOnboarded} from '@proxy/db/organization';
import {getUserFromId} from '@proxy/db/user';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';

export type MeResponse = {
	user: {id: string; email: string; name: string | null; image: string | null};
	/** False until the welcome flow is finished or skipped; the web app shows it instead of the app until then. */
	onboarded: boolean;
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
