import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {env} from '../../utils/env';

/**
 * The app's GitHub App client, when one is set up (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`),
 * which signing in, refreshing and revoking all speak with, and the headers every call to GitHub's
 * API takes, which names the app as GitHub asks of its clients.
 */

export const GITHUB_API = 'https://api.github.com';

export type GitHubClient = {clientId: string; clientSecret: string};

export function githubClient(): GitHubClient | null {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return null;
	}
	return {clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET};
}

export function requireGitHubClient(): Result<GitHubClient, ApiError> {
	const client = githubClient();
	if (!client) {
		return Err(ApiErr.validationError('GitHub isn’t set up on this server: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are missing'));
	}
	return Ok(client);
}

/**
 * What to do when the app isn't installed on any account the person reaches: authorizing it, which
 * the sign-in does, grants no repositories; installing it on GitHub, on their account or an
 * organization and choosing the repositories, does.
 */
export function installGitHubAppHint(): string {
	const where = env.GITHUB_APP_SLUG ? ` at https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : ' from its page on GitHub';
	return `The GitHub App isn’t installed on any account you can reach, so there are no repositories. Install it${where}, on your account or an organization, choosing the repositories agents may reach.`;
}

/** The headers every call to GitHub's API takes, with the token where there is one. */
export function githubHeaders(accessToken: string | null): Record<string, string> {
	return {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
		'user-agent': 'Personal Agent Proxy',
		...(accessToken === null ? {} : {authorization: `Bearer ${accessToken}`}),
	};
}
