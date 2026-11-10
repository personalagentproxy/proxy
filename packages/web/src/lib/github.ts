import type {GitHubInstallations} from '@proxy/contracts/github';

/** What a GitHub connection's page is given of what it reaches: what GitHub said, or why it couldn't be asked. */
export type GitHubReach = GitHubInstallations | {error: string};

/** How many repositories the Repositories tab lists, for its count: none where GitHub couldn't be asked. */
export function reachedRepositories(reach: GitHubReach): number {
	if ('error' in reach) {
		return 0;
	}
	return reach.installations.reduce(
		(sum, installation) => sum + installation.repositories.length,
		0,
	);
}
