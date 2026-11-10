import {Result} from 'ts-results-es';
import {z} from 'zod';

import {type Operation, operationRun} from './graphql';
import type {PushedRef} from './pkt-line';

/**
 * Which of the GitHub connection's actions (@proxy/integrations' catalog) a request relayed to
 * GitHub's API needs (route.ts). `GET` and `HEAD` read. A write is known by its path, or for
 * GraphQL by the fields at its mutation's root, never by the operation's name, which the client
 * picks: merging a pull request needs Merge; opening, editing, reviewing and commenting on pull
 * requests and issues needs Contribute; writing commits or moving a branch needs Push, or Push to
 * the default branch where the branch is the repository's default one; anything else, and
 * anything that can't be told, needs Manage. A ref a mutation names by its node id can't be told
 * from the default branch, so moving or deleting one through GraphQL needs Push to the default
 * branch.
 */

export type GitHubAction = 'read' | 'push' | 'pushDefault' | 'contribute' | 'merge' | 'manage';

// The catalog's order, in which a request's actions are checked and the last of them logged.
const ORDER: GitHubAction[] = ['read', 'push', 'pushDefault', 'contribute', 'merge', 'manage'];

/** A ref a push updates: a branch by its name, the default branch where that is all that is known, or another ref, such as a tag. */
export type RefTarget = {kind: 'branch'; name: string} | {kind: 'default'} | {kind: 'other'};

/**
 * What a request needs: actions; a push to refs known already; or a push to the ref its JSON body
 * names in `field`, `branch` (none being the default branch) or `ref` (`refs/heads/…`).
 */
export type ApiNeed = {kind: 'actions'; actions: GitHubAction[]} | {kind: 'push'; targets: RefTarget[]} | {kind: 'pushBody'; field: 'branch' | 'ref'};

function needs(...actions: GitHubAction[]): ApiNeed {
	return {kind: 'actions', actions};
}

/** The actions in the catalog's order, each once. */
export function ordered(actions: GitHubAction[]): GitHubAction[] {
	return ORDER.filter((action) => actions.includes(action));
}

/** What a ref, `refs/heads/fix-login` or `heads/fix-login` as GitHub's API writes it, is. */
export function refTarget(ref: string): RefTarget {
	const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
	if (full.startsWith('refs/heads/') && full.length > 'refs/heads/'.length) {
		return {kind: 'branch', name: full.slice('refs/heads/'.length)};
	}
	return {kind: 'other'};
}

/** What a git push updates: its refs, and the default branch too where the peek didn't reach them all, as one of the rest could be it. */
export function pushTargets(refs: PushedRef[], complete: boolean): RefTarget[] {
	const targets = refs.map(({ref}) => refTarget(ref));
	return complete ? targets : [...targets, {kind: 'default'}];
}

const bodySchema = z.object({branch: z.string().optional(), ref: z.string().optional()});

/** The ref a write's JSON body names in `field`; the default branch where it names none, or isn't JSON, as GitHub takes the first and the second can't be told. */
export function bodyTarget(body: Buffer | null, field: 'branch' | 'ref'): RefTarget {
	const json = Result.wrap((): unknown => JSON.parse(body?.toString('utf8') ?? '')).unwrapOr(null);
	const parsed = bodySchema.safeParse(json);
	const named = parsed.success ? parsed.data[field] : undefined;
	if (named === undefined || named === '') {
		return {kind: 'default'};
	}
	if (field === 'ref') {
		return refTarget(named);
	}
	return {kind: 'branch', name: named.startsWith('refs/heads/') ? named.slice('refs/heads/'.length) : named};
}

const GIT_OBJECTS = ['blobs', 'trees', 'commits', 'tags'];

// A write under `/repos/<owner>/<repo>/`, by the rest of its path.
function repositoryNeed(method: string, rest: string[]): ApiNeed {
	const [first, second, third] = rest;
	if (first === 'contents' && rest.length > 1 && (method === 'PUT' || method === 'DELETE')) {
		return {kind: 'pushBody', field: 'branch'};
	}
	if (first === 'git' && second === 'refs' && rest.length === 2 && method === 'POST') {
		return {kind: 'pushBody', field: 'ref'};
	}
	if (first === 'git' && second === 'refs' && rest.length > 2 && (method === 'PATCH' || method === 'DELETE')) {
		return {kind: 'push', targets: [refTarget(rest.slice(2).join('/'))]};
	}
	if (first === 'git' && second !== undefined && GIT_OBJECTS.includes(second) && rest.length === 2 && method === 'POST') {
		return needs('push');
	}
	if (first === 'merge-upstream' && rest.length === 1 && method === 'POST') {
		return {kind: 'pushBody', field: 'branch'};
	}
	if (first === 'branches' && rest.length > 2 && rest.at(-1) === 'rename' && method === 'POST') {
		return {kind: 'push', targets: [{kind: 'branch', name: rest.slice(1, -1).join('/')}]};
	}
	if (first === 'merges' && rest.length === 1 && method === 'POST') {
		return needs('merge');
	}
	if (first === 'pulls' && rest.length === 3 && third === 'merge') {
		return needs('merge');
	}
	if (first === 'pulls' && rest.length === 3 && third === 'update-branch') {
		return needs('push');
	}
	if (first === 'pulls' || first === 'issues') {
		return needs('contribute');
	}
	if (first === 'comments' || (first === 'commits' && third === 'comments')) {
		return needs('contribute');
	}
	return needs('manage');
}

/**
 * What a REST request, by its method and its path's segments, needs; each segment is read as GitHub
 * reads it, percent-encoding and all, so `heads/ma%69n` is main; one that can't be needs Manage.
 */
export function restNeed(method: string, segments: string[]): ApiNeed {
	if (method === 'GET' || method === 'HEAD') {
		return needs('read');
	}
	const decoded = Result.wrap(() => segments.map((segment) => decodeURIComponent(segment)));
	if (decoded.isErr()) {
		return needs('manage');
	}
	const [first, owner, repo, ...rest] = decoded.value;
	if (first !== 'repos' || owner === undefined || repo === undefined || rest.length === 0) {
		return needs('manage');
	}
	return repositoryNeed(method, rest);
}

// What each of GitHub's mutations gh runs, or an agent would, needs; any other needs Manage.
const MUTATIONS: Record<string, GitHubAction> = {
	mergePullRequest: 'merge',
	enablePullRequestAutoMerge: 'merge',
	disablePullRequestAutoMerge: 'merge',
	enqueuePullRequest: 'merge',
	dequeuePullRequest: 'merge',
	mergeBranch: 'merge',

	createRef: 'push',
	createLinkedBranch: 'push',
	updatePullRequestBranch: 'push',
	// By the ref's node id, or a branch named in variables: which branch can't be told here.
	updateRef: 'pushDefault',
	updateRefs: 'pushDefault',
	deleteRef: 'pushDefault',
	createCommitOnBranch: 'pushDefault',

	createPullRequest: 'contribute',
	updatePullRequest: 'contribute',
	closePullRequest: 'contribute',
	reopenPullRequest: 'contribute',
	revertPullRequest: 'contribute',
	markPullRequestReadyForReview: 'contribute',
	convertPullRequestToDraft: 'contribute',
	requestReviews: 'contribute',
	requestReviewsByLogin: 'contribute',
	addPullRequestReview: 'contribute',
	submitPullRequestReview: 'contribute',
	updatePullRequestReview: 'contribute',
	deletePullRequestReview: 'contribute',
	addPullRequestReviewComment: 'contribute',
	updatePullRequestReviewComment: 'contribute',
	deletePullRequestReviewComment: 'contribute',
	addPullRequestReviewThread: 'contribute',
	addPullRequestReviewThreadReply: 'contribute',
	resolveReviewThread: 'contribute',
	unresolveReviewThread: 'contribute',
	createIssue: 'contribute',
	updateIssue: 'contribute',
	closeIssue: 'contribute',
	reopenIssue: 'contribute',
	addSubIssue: 'contribute',
	removeSubIssue: 'contribute',
	reprioritizeSubIssue: 'contribute',
	addComment: 'contribute',
	updateIssueComment: 'contribute',
	deleteIssueComment: 'contribute',
	minimizeComment: 'contribute',
	unminimizeComment: 'contribute',
	addReaction: 'contribute',
	removeReaction: 'contribute',
	addLabelsToLabelable: 'contribute',
	removeLabelsFromLabelable: 'contribute',
	clearLabelsFromLabelable: 'contribute',
	addAssigneesToAssignable: 'contribute',
	removeAssigneesFromAssignable: 'contribute',
	addProjectV2ItemById: 'contribute',
	deleteProjectV2Item: 'contribute',
};

const graphqlBodySchema = z.object({query: z.string(), operationName: z.string().nullish()});

/**
 * What a GraphQL request's body runs, and the actions it needs: Read for a query; for a mutation,
 * each of its root fields' (MUTATIONS), Manage for one not there; and Manage for anything else,
 * a subscription, or a body that isn't a GraphQL request or doesn't say what it runs.
 */
export function graphqlNeed(body: Buffer): {actions: GitHubAction[]; operation: Operation | null} {
	const json = Result.wrap((): unknown => JSON.parse(body.toString('utf8'))).unwrapOr(null);
	const parsed = graphqlBodySchema.safeParse(json);
	if (!parsed.success) {
		return {actions: ['manage'], operation: null};
	}
	const run = operationRun(parsed.data.query, parsed.data.operationName ?? null);
	if (run === null) {
		return {actions: ['manage'], operation: null};
	}
	const operation: Operation = {type: run.type, name: run.name};
	if (run.type === 'query') {
		return {actions: ['read'], operation};
	}
	if (run.type !== 'mutation' || run.fields === null) {
		return {actions: ['manage'], operation};
	}
	return {actions: ordered(run.fields.map((field) => MUTATIONS[field] ?? 'manage')), operation};
}

/** The actions a push to `targets` needs, with `defaultBranch` the repository's: Push, and Push to the default branch where one of them is it. */
export function pushActions(targets: RefTarget[], defaultBranch: string | null): GitHubAction[] {
	const toDefault = targets.some((target) => target.kind === 'default' || (target.kind === 'branch' && (defaultBranch === null || target.name === defaultBranch)));
	return toDefault ? ['push', 'pushDefault'] : ['push'];
}

/** Whether which branch is the default has to be asked of GitHub to tell what a push to `targets` needs. */
export function needsDefaultBranch(targets: RefTarget[]): boolean {
	return targets.some((target) => target.kind === 'branch') && !targets.some((target) => target.kind === 'default');
}
