import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {GitHubInstallation, GitHubInstallations} from '@proxy/contracts/github';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {requireViewer} from '../../utils/user-org';
import {signInRoutes} from '../connect-flow';
import {requireConnection} from '../managed';
import {githubClient, installGitHubAppUrl, requireGitHubClient} from './github-app';
import {callGitHub} from './github-client';
import {exchangeGitHubCode, githubAuthorizeUrl} from './github-oauth';
import {fetchInstallationRepositories, fetchInstallations, type Installation, PAGE_SIZE, repositoryView} from './installations';

/**
 * Connecting GitHub by signing in to it with the app's GitHub App client. The connection shows the
 * login signed in with and is found by GitHub's id for the account, so signing in again gives it
 * the new tokens and the login as it is now, even after the login changed. A new GitHub connection
 * lets agents read repositories by default. Without a client set up, the start goes back to the
 * catalog with `?error=github-unconfigured`, which the catalog turns into what the server is missing.
 */
export const {handleStart: handleStartGitHubRoute, handleCallback: handleGitHubCallbackRoute} = signInRoutes({
	integrationId: 'github',
	name: 'GitHub',
	keptSchema: z.null(),
	configured: () => githubClient() !== null,
	start: (request) =>
		Do(async ($) => {
			return {url: githubAuthorizeUrl($(requireGitHubClient()), request), kept: null};
		}),
	finish: ({redirectUri, code}) =>
		Do(async ($) => {
			const {account, credential} = $(await exchangeGitHubCode($(requireGitHubClient()), {redirectUri, code}));
			return {account: account.login, accountId: account.id, credential, defaults: ['read']};
		}),
});

// How many pages of an installation's repositories the tab is given: past that, it says there are more.
const TAB_PAGES = 3;

async function installationView(accessToken: string, installation: Installation): Promise<Result<GitHubInstallation, ApiError>> {
	return Do(async ($) => {
		const repositories = [];
		let total = 0;
		for (let page = 1; page <= TAB_PAGES; page++) {
			const fetched = $(await fetchInstallationRepositories(accessToken, installation.id, page));
			repositories.push(...fetched.repositories.map(repositoryView));
			total = fetched.total;
			if (fetched.repositories.length < PAGE_SIZE) {
				break;
			}
		}
		return {
			account: installation.account?.login ?? 'GitHub',
			accountType: installation.account?.type === 'Organization' ? 'Organization' : 'User',
			all: installation.repository_selection === 'all',
			settingsUrl: installation.html_url,
			repositories,
			more: repositories.length < total,
		};
	});
}

/**
 * `GET /api/orgs/:org/connections/:connectionId/github/installations`: what the connection
 * reaches, for the Repositories tab of its page: the accounts the app is installed on that the
 * person who signed in can see, each with its repositories, and where to install it on another.
 * For anyone who sees the connection, as reading its records is.
 */
export function handleGitHubInstallationsRoute(request: AuthenticatedRequest): Promise<Result<GitHubInstallations, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connection = $(await requireConnection(viewer, request.params.connectionId ?? ''));
		if (connection.integrationId !== 'github') {
			return $(Err(ApiErr.notFound('connection', connection.id)));
		}
		const client = $(requireGitHubClient());
		return $(
			await callGitHub(connection, (accessToken) =>
				Do(async ($$) => {
					const installations = $$(await fetchInstallations(accessToken));
					const views: GitHubInstallation[] = [];
					for (const installation of installations) {
						views.push($$(await installationView(accessToken, installation)));
					}
					return {installations: views, installUrl: installGitHubAppUrl(client)};
				}),
			),
		);
	});
}
