import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {GITHUB_ORIGINS} from './origins';
import {upstreamUrl} from './requests';

/**
 * A repository's default branch, asked of GitHub's API with the connection's token, for telling
 * whether a push updates it (needs.ts): asked each time, as the person can change it at GitHub
 * at any time. A redirect, as for a renamed repository, is never followed with the token, and is
 * taken as GitHub not saying.
 */

export type DefaultBranchFailure = {kind: 'unreachable'} | {kind: 'rejected'} | {kind: 'status'; status: number};

const repositorySchema = z.object({default_branch: z.string().min(1)});

/** `repository`'s default branch, `owner/repo`, or why GitHub didn't say. */
export async function defaultBranch(repository: string, token: string, signal: AbortSignal): Promise<Result<string, DefaultBranchFailure>> {
	const url = upstreamUrl(GITHUB_ORIGINS.api, `/repos/${repository}`, '');
	if (url === null) {
		return Err({kind: 'status', status: 400});
	}
	const answer = await Result.wrapAsync(() =>
		fetch(url, {
			headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'personal-agent-proxy'},
			redirect: 'manual',
			signal,
		}),
	);
	if (answer.isErr()) {
		return Err({kind: 'unreachable'});
	}
	if (answer.value.status === 401) {
		return Err({kind: 'rejected'});
	}
	if (!answer.value.ok) {
		return Err({kind: 'status', status: answer.value.status});
	}
	const json = await Result.wrapAsync((): Promise<unknown> => answer.value.json());
	const parsed = repositorySchema.safeParse(json.unwrapOr(null));
	if (!parsed.success) {
		return Err({kind: 'status', status: answer.value.status});
	}
	return Ok(parsed.data.default_branch);
}
