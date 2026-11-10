import type {Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, type FetchError, httpRequest} from '@proxy/utils';

import {callWithToken, freshCredential, type TokenRefresher} from '../token-session';
import {githubHeaders, requireGitHubClient} from './github-app';
import {githubCredentialSchema, isExpiring, refreshGitHubTokens, type GitHubCredential} from './github-oauth';

/**
 * GitHub's REST API with a connection's access token: JSON in and out, and GitHub's errors turned
 * into what they mean for the agent.
 */

const TIMEOUT_MS = 30_000;

type StoredConnection = {id: string; credential: string | null};

/**
 * What one of GitHub's errors means: a token to refresh, nothing there (or nothing the token may
 * see, which GitHub answers the same way), or GitHub busy or out of reach, a 403 being how it
 * says it is rate limiting as well as a 429.
 */
function githubError(error: FetchError): ApiError {
	if (error.kind === 'http' && error.status === 401) {
		return ApiErr.credentialsRejected();
	}
	if (error.kind === 'http' && error.status === 404) {
		return ApiErr.notFound('GitHub resource');
	}
	return ApiErr.providerUnreachable(error);
}

/** A GET to GitHub's API, its answer read with `schema`. */
export async function githubRequest<S extends z.ZodType>(accessToken: string, url: URL | string, schema: S): Promise<Result<z.infer<S>, ApiError>> {
	const answer = await httpRequest(url, {headers: githubHeaders(accessToken)}, {schema, timeoutMs: TIMEOUT_MS});
	return answer.mapErr(githubError);
}

/** How a GitHub connection's tokens are refreshed: with the app's own client. */
export const githubRefresher: TokenRefresher<GitHubCredential> = {
	name: 'GitHub',
	schema: githubCredentialSchema,
	isExpiring,
	refresh: (credential) =>
		Do(async ($) => {
			return $(await refreshGitHubTokens($(requireGitHubClient()), credential));
		}),
};

/**
 * Calls GitHub with a connection's access token: refreshed first when it is running out, and once
 * more when GitHub turns it down anyway. A connection GitHub won't refresh any more is
 * `credentials_rejected`, and has to be signed in again.
 */
export function callGitHub<T>(connection: StoredConnection, call: (accessToken: string) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return callWithToken(githubRefresher, connection, (credential) => call(credential.accessToken));
}

/**
 * A connection's credential with an access token good for a while yet, refreshed first when it is
 * running out: for a request relayed to GitHub as it streams (cli/github), which can't be made again
 * with a new token. One GitHub won't refresh any more is `credentials_rejected`.
 */
export function freshGitHubCredential(connection: StoredConnection): Promise<Result<GitHubCredential, ApiError>> {
	return freshCredential(githubRefresher, connection);
}
