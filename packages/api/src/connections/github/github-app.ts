import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {env} from '../../utils/env';

/**
 * The app's GitHub App client, when one is set up (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`),
 * which signing in, refreshing and revoking all speak with, and the headers every call to GitHub's
 * API takes, which names the app as GitHub asks of its clients.
 */

export const GITHUB_API = 'https://api.github.com';

/** The app's client, and its name as it is in its address, `github.com/apps/<slug>`, where people install it. */
export type GitHubClient = {clientId: string; clientSecret: string; slug: string};

export function githubClient(): GitHubClient | null {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.GITHUB_APP_SLUG) {
		return null;
	}
	return {clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, slug: env.GITHUB_APP_SLUG};
}

export function requireGitHubClient(): Result<GitHubClient, ApiError> {
	const client = githubClient();
	if (!client) {
		return Err(ApiErr.validationError('GitHub isn’t set up on this server: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and GITHUB_APP_SLUG are missing'));
	}
	return Ok(client);
}

/** GitHub's page for installing the app on an account, which asks which account and which repositories. */
export function installGitHubAppUrl(client: GitHubClient): string {
	return `https://github.com/apps/${encodeURIComponent(client.slug)}/installations/new`;
}

/**
 * What to do when the app isn't installed on any account the person reaches: authorizing it, which
 * the sign-in does, grants no repositories; installing it on GitHub, on their account or an
 * organization and choosing the repositories, does.
 */
export function installGitHubAppHint(client: GitHubClient): string {
	return `The GitHub App isn’t installed on any account you can reach, so there are no repositories. Install it at ${installGitHubAppUrl(client)}, on your account or an organization, choosing the repositories agents may reach.`;
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
