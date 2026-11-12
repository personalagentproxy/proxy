import {repositoriesConnector} from '../../records/github-repositories';
import type {ApiIntegration} from '../integration';
import {REVOKE_GITHUB} from './revoke';
import {handleGitHubCallbackRoute, handleStartGitHubRoute} from './route';
import {z} from 'zod';
import {callGitHub, githubRequest} from './github-client';

/**
 * GitHub, signed in to through the app's GitHub App as the person, its repositories read live
 * from GitHub's API with the connection's tokens. The authorization is revoked when its last
 * connection goes.
 */
export const GITHUB_INTEGRATION: ApiIntegration = {
	id: 'github',
	check: (connection) => callGitHub(connection, async (token) => (await githubRequest(token, 'https://api.github.com/user', z.object({id: z.number()}))).map(() => undefined)),
	connectors: {repositories: repositoriesConnector},
	connect: {kind: 'signIn', name: 'GitHub', routes: () => ({handleStart: handleStartGitHubRoute, handleCallback: handleGitHubCallbackRoute})},
	revoke: REVOKE_GITHUB,
};
