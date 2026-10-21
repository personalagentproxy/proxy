import type {IncomingHttpHeaders} from 'node:http';

import {getAuthenticatedSessionDatabase} from '@proxy/db/auth';
import {ApiErr, type ApiError, type Experiment, getSessionTokenFromHeader} from '@proxy/utils';
import {Err, Ok, type Result} from 'ts-results-es';

import {hashToken} from '../auth/session';

export type AuthenticatedApiRequest = {
	userId: string;
	email: string;
	name?: string;
	// The session, by the hash of its token, and the organization it has open in the switcher.
	sessionTokenHash: string;
	activeOrgId: string | null;
	/** The experiments on for the organization the user works in; ask with `hasExperiment(request.user, …)`. */
	experiments: Experiment[];
};

/** Authenticates a user from the session cookie. */
export async function authenticateApiRequest(headers: IncomingHttpHeaders): Promise<Result<AuthenticatedApiRequest, ApiError>> {
	const sessionToken = getSessionTokenFromHeader(headers.cookie);
	if (!sessionToken) {
		return Err(ApiErr.unauthenticated());
	}

	const sessionTokenHash = hashToken(sessionToken);
	const sessionResult = await getAuthenticatedSessionDatabase(sessionTokenHash);
	if (sessionResult.isErr()) {
		return sessionResult;
	}

	if (!sessionResult.value) {
		return Err(ApiErr.unauthenticated());
	}

	return Ok({
		userId: sessionResult.value.userId,
		email: sessionResult.value.user.email,
		name: sessionResult.value.user.name ?? undefined,
		sessionTokenHash,
		activeOrgId: sessionResult.value.activeOrgId,
		experiments: sessionResult.value.experiments,
	});
}
