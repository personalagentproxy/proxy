import {z} from 'zod';

import {Do} from '@proxy/utils';

import {signInRoutes} from '../connect-flow';
import {githubClient, requireGitHubClient} from './github-app';
import {exchangeGitHubCode, githubAuthorizeUrl} from './github-oauth';

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
