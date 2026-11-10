import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';
import type {GitHubRepository} from '@proxy/contracts/github';

import {GITHUB_API} from './github-app';
import {githubRequest} from './github-client';

/**
 * The installations of the app a person can see, and each one's repositories, as GitHub's API
 * lists them for the person's token: what the Repositories tab shows and the repositories
 * collection lists, a hundred to a page.
 */

export const PAGE_SIZE = 100;

const installationSchema = z.object({
	id: z.number(),
	account: z.object({login: z.string(), type: z.string().optional()}).nullable(),
	repository_selection: z.enum(['all', 'selected']).optional(),
	// The installation's settings page on GitHub, where its repositories are picked.
	html_url: z.string(),
});

const installationsSchema = z.object({installations: z.array(installationSchema)});

export type Installation = z.infer<typeof installationSchema>;

const repositorySchema = z.object({
	full_name: z.string(),
	description: z.string().nullable(),
	private: z.boolean(),
	default_branch: z.string().optional(),
	language: z.string().nullable().optional(),
	html_url: z.string(),
	pushed_at: z.string().nullable().optional(),
	updated_at: z.string().nullable().optional(),
});

const repositoriesSchema = z.object({total_count: z.number(), repositories: z.array(repositorySchema)});

export type Repository = z.infer<typeof repositorySchema>;

export {repositorySchema};

/** The installations the token can see. */
export function fetchInstallations(accessToken: string): Promise<Result<Installation[], ApiError>> {
	return githubRequest(accessToken, `${GITHUB_API}/user/installations?per_page=${PAGE_SIZE}`, installationsSchema).then((answer) => answer.map(({installations}) => installations));
}

/** One page of an installation's repositories the token can see, with how many there are in all. */
export function fetchInstallationRepositories(accessToken: string, installationId: number, page: number): Promise<Result<{repositories: Repository[]; total: number}, ApiError>> {
	const url = `${GITHUB_API}/user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}&page=${page}`;
	return githubRequest(accessToken, url, repositoriesSchema).then((answer) => answer.map(({repositories, total_count}) => ({repositories, total: total_count})));
}

/** A repository as the tab shows it. */
export function repositoryView(repository: Repository): GitHubRepository {
	return {fullName: repository.full_name, visibility: repository.private ? 'Private' : 'Public', pushedAt: repository.pushed_at ?? null, url: repository.html_url};
}
