import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {type Operation, operationRun} from './graphql';

/**
 * What a request relayed to GitHub is (route.ts): where it goes, the repository it names, and the
 * connection's action it needs. The upstream URL is built on a fixed origin (origins.ts) from a
 * path checked first, and checked again once built to be on that origin with that path, so no
 * path, `//host`, `@`, an encoded slash or a `..` among them, sends the token anywhere else.
 *
 * git: only its smart HTTP, `info/refs?service=…` and the two services' POSTs, of a repository
 * named `<owner>/<repo>`, with or without `.git`. Upload-pack needs Read, receive-pack Push.
 * The API: any path, `GET` and `HEAD` needing Read, a GraphQL request Read for a query and Write
 * for a mutation, anything else Write.
 */

export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** The git request's step: the refs advertised, or the service's POST. */
export type GitPhase = 'refs' | 'pack';

export type GitRequest = {service: GitService; phase: GitPhase; repository: string; url: URL};

/** A git request that isn't relayed, with what git can show of why: as the service's answer where it is one. */
export type GitRefusal = {message: string; service: GitService | null; phase: GitPhase};

export type ApiRequest = {path: string; repository: string | null; url: URL};

const LFS = 'Git LFS isn’t supported through pap git yet: only the repository’s own objects can be fetched and pushed.';
const SMART_ONLY = 'Only git’s smart HTTP is relayed: info/refs?service=git-upload-pack or git-receive-pack, and their POSTs.';
const NOT_A_REPOSITORY = 'Not a GitHub repository: use https://github.com/<owner>/<repo>.git.';

// GitHub's names: an owner's letters, digits and dashes, a repository's those and `.` and `_`.
const GIT_PATH = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const LFS_PATH = /^\/[^/]+\/[^/]+\/info\/lfs(?:\/|$)/;

function splitTarget(target: string): {path: string; search: string} {
	const mark = target.indexOf('?');
	if (mark === -1) {
		return {path: target, search: ''};
	}
	return {path: target.slice(0, mark), search: target.slice(mark)};
}

/** `path` and `search` on `origin`, or null where the URL built isn't exactly that: another host, or the path changed by resolving it. */
export function upstreamUrl(origin: string, path: string, search: string): URL | null {
	const base = new URL(origin);
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
		return null;
	}
	const url = Result.wrap(() => new URL(`${base.origin}${path}${search}`)).unwrapOr(null);
	if (url === null || url.origin !== base.origin || url.pathname !== path || url.username !== '' || url.password !== '') {
		return null;
	}
	return url;
}

function service(name: string | null): GitService | null {
	if (name === 'git-upload-pack' || name === 'git-receive-pack') {
		return name;
	}
	return null;
}

function refuseGit(message: string, refused: GitService | null = null, phase: GitPhase = 'refs'): Result<GitRequest, GitRefusal> {
	return Err({message, service: refused, phase});
}

/** A git request, by its method and its path under the git route with its query, relayed to `origin`. */
export function gitRequest(method: string, target: string, origin: string): Result<GitRequest, GitRefusal> {
	const {path, search} = splitTarget(target);
	if (LFS_PATH.test(path)) {
		return refuseGit(LFS);
	}
	const match = GIT_PATH.exec(path);
	if (!match) {
		return refuseGit(path.includes('%') ? NOT_A_REPOSITORY : SMART_ONLY);
	}
	const [, owner = '', repo = '', step = ''] = match;
	if (repo === '.' || repo === '..') {
		return refuseGit(NOT_A_REPOSITORY);
	}
	const repository = `${owner}/${repo}`;
	if (step === 'info/refs') {
		const params = new URLSearchParams(search);
		const asked = service(params.get('service'));
		if (asked === null || [...params.keys()].length !== 1) {
			return refuseGit(SMART_ONLY);
		}
		if (method !== 'GET') {
			return refuseGit(SMART_ONLY, asked);
		}
		const url = upstreamUrl(origin, `/${repository}.git/info/refs`, `?service=${asked}`);
		return url === null ? refuseGit(NOT_A_REPOSITORY, asked) : Ok({service: asked, phase: 'refs', repository, url});
	}
	const posted = service(step);
	if (posted === null || method !== 'POST' || search !== '') {
		return refuseGit(SMART_ONLY, posted, 'pack');
	}
	const url = upstreamUrl(origin, `/${repository}.git/${posted}`, '');
	return url === null ? refuseGit(NOT_A_REPOSITORY, posted, 'pack') : Ok({service: posted, phase: 'pack', repository, url});
}

/** The action a git service needs: Read to fetch, Push to push. */
export function gitAction(gitService: GitService): 'read' | 'push' {
	return gitService === 'git-receive-pack' ? 'push' : 'read';
}

// A path segment that resolving the URL, or GitHub, could take as a step up or as a separator.
const UNSAFE_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

/** An API request, by its path under the API route with its query, relayed to `origin`; null for a path that isn't one. */
export function apiRequest(target: string, origin: string): ApiRequest | null {
	const {path, search} = splitTarget(target);
	const segments = path.split('/').slice(1);
	if (segments.length === 0 || segments.some((segment) => segment === '' || UNSAFE_SEGMENT.test(segment)) || ENCODED_SEPARATOR.test(path)) {
		return null;
	}
	const url = upstreamUrl(origin, path, search);
	if (url === null) {
		return null;
	}
	const [first, owner, repo] = segments;
	return {path, repository: first === 'repos' && owner && repo ? `${owner}/${repo}` : null, url};
}

/** Whether a request is GitHub's GraphQL endpoint's, whose body says whether it reads or writes. */
export function isGraphql(method: string, path: string): boolean {
	return method === 'POST' && path === '/graphql';
}

/** The action an API request needs, but for GraphQL's (`graphqlAction`): Read to read, Write for anything else. */
export function apiAction(method: string): 'read' | 'write' {
	return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

const graphqlBodySchema = z.object({query: z.string(), operationName: z.string().nullish()});

/**
 * What a GraphQL request's body runs, and the action it needs: Read for a query, Write for a
 * mutation, and Write too for anything it can't tell, a body that isn't JSON among them.
 */
export function graphqlAction(body: Buffer): {action: 'read' | 'write'; operation: Operation | null} {
	const json = Result.wrap((): unknown => JSON.parse(body.toString('utf8'))).unwrapOr(null);
	const parsed = graphqlBodySchema.safeParse(json);
	if (!parsed.success) {
		return {action: 'write', operation: null};
	}
	const operation = operationRun(parsed.data.query, parsed.data.operationName ?? null);
	return {action: operation?.type === 'query' ? 'read' : 'write', operation};
}
