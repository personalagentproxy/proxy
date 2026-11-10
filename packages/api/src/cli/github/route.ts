import type {Request, Response} from 'express';

import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {CLI_GITHUB_API_PATH, CLI_GITHUB_GIT_PATH, type GitHubIdentity, PAP_CONNECTION_HEADER} from '@proxy/contracts/cli-github';
import {API_REQUESTS_ID, GIT_REQUESTS_ID} from '@proxy/integrations';

import {failureOf, type Outcome} from '../../agent-side/tools';
import {freshGitHubCredential} from '../../connections/github/github-client';
import {readGitHubCredential} from '../../connections/github/github-oauth';
import {log} from '../../observability/log';
import {addContext} from '../../observability/request-context';
import {agentErrorMessage} from '../../script/agent-host';
import type {CliRequest} from '../../server/middleware/require-cli';
import {authenticateCliRequest, type CliCaller} from '../authenticate';
import {apiQuery, type GitHubEntry, logGitHubRequest, pushQuery} from './activity';
import {githubTarget, type GitHubTarget, refusalMessage} from './connection';
import {abortWithClient, forwardedHeaders, passBack, relay} from './forward';
import type {Operation} from './graphql';
import {GITHUB_ORIGINS} from './origins';
import {bodyStream, peekBody, readBody} from './peek';
import {errPacket, leadingPackets, pushedRefs, sidebandError} from './pkt-line';
import {apiAction, apiRequest, type GitPhase, type GitRequest, type GitService, gitAction, gitRequest, graphqlAction, isGraphql} from './requests';

/**
 * `/api/cli/github/…` (@proxy/contracts/cli-github): GitHub's git and API requests from a sandbox,
 * for `pap git` and `pap gh`, relayed to GitHub as the person, with the connection's token, which
 * never goes back. Each is authenticated with the command's token (cli/authenticate.ts), for the
 * GitHub connection it names or the agent's only one (connection.ts), and checked against the
 * action it needs (requests.ts) as the gate does a tool run; one the agent doesn't have is refused
 * and logged as denied. The token is refreshed before the request where it is running out, since
 * a streamed request can't be made twice; GitHub turning it down anyway is the sign-in rejected,
 * logged as failed. What is logged of what was relayed (activity.ts): a fetch, by its `info/refs`,
 * which git asks for once for each fetch, clone or ls-remote; a push, by its POST, with the refs it
 * updates, read from the start of its body; and every API request. Anything relayed is allowed
 * whatever GitHub answered, but its 401, and GitHub out of reach, which fail.
 *
 * Refusals are in words a model reads: for git, an `ERR` packet in the service's own answer, which
 * git prints as `fatal: remote error: <message>`, or for a push's POST the side band's error, which
 * it prints as `remote error: <message>`; plain text where the request is no service's;
 * for the API, `{"message": …}` as GitHub's own refusals are, which gh prints.
 */

// How much of a push's start is read for the log: its commands come long before this.
const PEEK_LIMIT = 64 * 1024;

// The most of a GraphQL request read, to tell a query from a mutation, which GitHub's are far under.
const GRAPHQL_LIMIT = 1024 * 1024;

type Refusal = {status: number; message: string};

const UNREACHABLE: Refusal = {status: 502, message: 'GitHub could not be reached; try again.'};
const UNLOGGED: Refusal = {status: 500, message: 'The request could not be written to the activity log, so it was not made; try again.'};
const BAD_API_PATH = 'Not a path of GitHub’s API: send the path as it is after https://api.github.com, without `..`, empty or encoded slashes.';

// The path under a route, with its query, as the client sent it: Express's own `url` under a mount
// has had a slash after the mount's path taken, so `//host` would come out as `/host`.
function pathUnder(request: Request, mount: string): string {
	return request.originalUrl.slice(mount.length);
}

function namedConnection(request: Request): string | undefined {
	const value = request.headers[PAP_CONNECTION_HEADER];
	return Array.isArray(value) ? value[0] : value;
}

// An error, in the words the agent side gives a model, as code in a sandbox calls things; GitHub
// turning the connection down is the server between failing, as GitHub out of reach is.
function refusalOf(error: ApiError): Refusal {
	const message = 'message' in error && error.message ? error.message : agentErrorMessage(error, 'cli');
	return {status: error.kind === 'credentials_rejected' ? 502 : error.statusCode, message};
}

const REJECTED = refusalOf(ApiErr.credentialsRejected());

/** A git refusal: in the service's own answer, as an `ERR` packet git shows, where the request is a service's; else plain text. */
function answerGit(response: Response, shape: {service: GitService | null; phase: GitPhase}, refusal: Refusal): void {
	if (shape.service === null) {
		response.status(refusal.status).type('text/plain').send(`${refusal.message}\n`);
		return;
	}
	const kind = shape.phase === 'refs' ? 'advertisement' : 'result';
	response.status(200).set({'content-type': `application/x-${shape.service}-${kind}`, 'cache-control': 'no-cache'});
	const pushing = shape.service === 'git-receive-pack' && shape.phase === 'pack';
	response.end(pushing ? sidebandError(refusal.message) : errPacket(refusal.message));
}

/** An API refusal, as GitHub's API words its own. */
function answerApi(response: Response, refusal: Refusal): void {
	response.status(refusal.status).json({message: refusal.message});
}

// Logs a refusal as denied, or a failure, before it is answered; where the log can't be written,
// the answer is that instead, as a tool run that can't be logged fails.
async function logged(caller: CliCaller, target: GitHubTarget, entry: GitHubEntry, outcome: Outcome, startedAt: number, refusal: Refusal, error?: string): Promise<Refusal> {
	const written = await logGitHubRequest(caller, target.connection, entry, outcome, startedAt, error);
	return written.isOk() ? refusal : UNLOGGED;
}

// What was relayed, logged as allowed after GitHub answered; it was made, so a log that can't be
// written is the server's to see, and the answer goes back all the same.
async function logRelayed(caller: CliCaller, target: GitHubTarget, entry: GitHubEntry, startedAt: number): Promise<void> {
	const written = await logGitHubRequest(caller, target.connection, entry, 'allowed', startedAt);
	if (written.isErr()) {
		log.error('A request relayed to GitHub could not be logged', {kind: written.error.kind, collection: entry.collection, action: entry.action});
	}
}

type Authed = {caller: CliCaller; target: GitHubTarget};

// The caller and the GitHub connection, or what to refuse with.
function authorize(request: Request): Promise<Result<Authed, Refusal>> {
	return Do<Authed, Refusal>(async ($) => {
		const caller = $((await authenticateCliRequest(request.headers)).mapErr(refusalOf));
		addContext({agentId: caller.agent.agentId, orgId: caller.agent.orgId});
		const target = $((await githubTarget(caller, namedConnection(request))).mapErr(refusalOf));
		return {caller, target};
	});
}

/** The connection's access token, good for a while yet, or a refusal, logged as failed with `entry`. */
function tokenFor({caller, target}: Authed, entry: GitHubEntry, startedAt: number): Promise<Result<string, Refusal>> {
	return Do<string, Refusal>(async ($) => {
		const credential = await freshGitHubCredential(target.connection);
		if (credential.isErr()) {
			return $(Err(await logged(caller, target, entry, 'failed', startedAt, refusalOf(credential.error), failureOf(credential.error))));
		}
		return credential.value.accessToken;
	});
}

// What GitHub answered that is a refusal rather than its answer: it turned the token down (401), or
// it couldn't be reached; each logged as failed. Null where GitHub answered, whatever it said.
async function relayFailure(authed: Authed, entry: GitHubEntry, startedAt: number, answer: Result<globalThis.Response, Error>): Promise<Refusal | null> {
	if (answer.isErr()) {
		// The error's name alone: its words can hold the URL, never anything more.
		log.warn('GitHub could not be reached for a relayed request', {collection: entry.collection, errorName: answer.error.name});
		return logged(authed.caller, authed.target, entry, 'failed', startedAt, UNREACHABLE, 'provider_unreachable');
	}
	if (answer.value.status !== 401) {
		return null;
	}
	await Result.wrapAsync(() => answer.value.body?.cancel() ?? Promise.resolve());
	return logged(authed.caller, authed.target, entry, 'failed', startedAt, REJECTED, 'credentials_rejected 401');
}

// Whether a request has a body to relay: one it says the length of, or sends chunked.
function hasBody(request: Request): boolean {
	const length = request.headers['content-length'];
	return (length !== undefined && length !== '0') || request.headers['transfer-encoding'] !== undefined;
}

type GitBody = {body: ReadableStream<Uint8Array> | null; logged: GitHubEntry | null};

// A push's body to relay, and its entry with the refs it updates, read from the commands at its
// start. git never compresses a push, so one that is compressed is relayed and logged without them.
async function pushBody(request: Request, entry: GitHubEntry): Promise<Result<GitBody, Error>> {
	const encoding = (request.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
	if (encoding !== 'identity') {
		return Ok({body: bodyStream(request), logged: entry});
	}
	const peeked = await Result.wrapAsync(() => peekBody(request, PEEK_LIMIT, (start) => leadingPackets(start).flushed));
	return peeked
		.mapErr((error) => (error instanceof Error ? error : new Error(String(error))))
		.map(({start, body}) => {
			const {refs, complete} = pushedRefs(start);
			return {body, logged: {...entry, query: pushQuery(refs, complete)}};
		});
}

// A git request's body to relay, and its entry once GitHub answers: a fetch's at its `info/refs`,
// a push's at its POST; none for the rest, the upload-pack POSTs of a fetch logged already.
async function gitBody(request: Request, git: GitRequest, entry: GitHubEntry): Promise<Result<GitBody, Error>> {
	if (git.phase === 'refs') {
		return Ok({body: null, logged: git.service === 'git-upload-pack' ? entry : null});
	}
	if (git.service === 'git-upload-pack') {
		return Ok({body: bodyStream(request), logged: null});
	}
	return pushBody(request, entry);
}

/**
 * `/api/cli/github/git/<owner>/<repo>[.git]/…`: git's smart HTTP, relayed to GitHub's git server
 * with the token as git's Basic password.
 */
export async function handleGitHubGitRoute(request: Request, response: Response): Promise<void> {
	const startedAt = Date.now();
	const parsed = gitRequest(request.method, pathUnder(request, CLI_GITHUB_GIT_PATH), GITHUB_ORIGINS.git);
	if (parsed.isErr()) {
		answerGit(response, parsed.error, {status: 400, message: parsed.error.message});
		return;
	}
	const git = parsed.value;
	const authed = await authorize(request);
	if (authed.isErr()) {
		answerGit(response, git, authed.error);
		return;
	}
	const {caller, target} = authed.value;
	const action = gitAction(git.service);
	const entry: GitHubEntry = {collection: GIT_REQUESTS_ID, action, repository: git.repository, query: null};
	if (!target.actions.includes(action)) {
		const neededFor = action === 'push' ? 'git push' : 'cloning and fetching';
		answerGit(response, git, await logged(caller, target, entry, 'denied', startedAt, {status: 403, message: refusalMessage(target, action, neededFor)}));
		return;
	}
	const token = await tokenFor(authed.value, entry, startedAt);
	if (token.isErr()) {
		answerGit(response, git, token.error);
		return;
	}
	const pack = await gitBody(request, git, entry);
	if (pack.isErr()) {
		// The client went before its request was read: there is no one to answer.
		response.destroy();
		return;
	}
	const controller = abortWithClient(response);
	const answer = await relay({
		method: request.method,
		url: git.url,
		headers: forwardedHeaders(request.headers, `Basic ${Buffer.from(`x-access-token:${token.value}`).toString('base64')}`),
		body: pack.value.body,
		signal: controller.signal,
	});
	if (controller.signal.aborted) {
		return;
	}
	const failure = await relayFailure(authed.value, entry, startedAt, answer);
	if (failure !== null || answer.isErr()) {
		answerGit(response, git, failure ?? UNREACHABLE);
		return;
	}
	const relayed = pack.value.logged;
	if (relayed !== null) {
		await logRelayed(caller, target, relayed, startedAt);
	}
	await passBack(response, answer.value);
}

type ApiBody = {action: 'read' | 'write'; operation?: Operation | null; body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | null};

// What an API request needs and the body to relay: a GraphQL request's read whole, as far as
// GRAPHQL_LIMIT, to tell a query from a mutation, and taken as a write where it is compressed; any
// other's streamed. Null for a GraphQL request over the limit.
async function apiBody(request: Request, path: string): Promise<Result<ApiBody | null, Error>> {
	const {method} = request;
	const stream = (): ReadableStream<Uint8Array> | null => (hasBody(request) ? bodyStream(request) : null);
	if (!isGraphql(method, path)) {
		return Ok({action: apiAction(method), body: method === 'GET' || method === 'HEAD' ? null : stream()});
	}
	const encoding = (request.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
	if (encoding !== 'identity') {
		return Ok({action: 'write', operation: null, body: stream()});
	}
	const read = await Result.wrapAsync(() => readBody(request, GRAPHQL_LIMIT));
	return read.mapErr((error) => (error instanceof Error ? error : new Error(String(error)))).map((body) => (body === null ? null : {...graphqlAction(body), body: new Uint8Array(body)}));
}

/**
 * `/api/cli/github/api/<path>`: GitHub's API, relayed to `https://api.github.com/<path>` with the
 * token as the bearer, and every request logged.
 */
export async function handleGitHubApiRoute(request: Request, response: Response): Promise<void> {
	const startedAt = Date.now();
	const api = apiRequest(pathUnder(request, CLI_GITHUB_API_PATH), GITHUB_ORIGINS.api);
	if (api === null) {
		answerApi(response, {status: 400, message: BAD_API_PATH});
		return;
	}
	const authed = await authorize(request);
	if (authed.isErr()) {
		answerApi(response, authed.error);
		return;
	}
	const {caller, target} = authed.value;
	const read = await apiBody(request, api.path);
	if (read.isErr()) {
		response.destroy();
		return;
	}
	if (read.value === null) {
		answerApi(response, {status: 413, message: `A GraphQL request over ${GRAPHQL_LIMIT / 1024 / 1024} MB isn’t relayed: send a smaller one.`});
		return;
	}
	const {action, operation, body} = read.value;
	const entry: GitHubEntry = {collection: API_REQUESTS_ID, action, repository: api.repository, query: apiQuery(request.method, api.path, operation)};
	if (!target.actions.includes(action)) {
		answerApi(response, await logged(caller, target, entry, 'denied', startedAt, {status: 403, message: refusalMessage(target, action, `${request.method} ${api.path}`)}));
		return;
	}
	const token = await tokenFor(authed.value, entry, startedAt);
	if (token.isErr()) {
		answerApi(response, token.error);
		return;
	}
	const controller = abortWithClient(response);
	const answer = await relay({method: request.method, url: api.url, headers: forwardedHeaders(request.headers, `Bearer ${token.value}`), body, signal: controller.signal});
	if (controller.signal.aborted) {
		return;
	}
	const failure = await relayFailure(authed.value, entry, startedAt, answer);
	if (failure !== null || answer.isErr()) {
		answerApi(response, failure ?? UNREACHABLE);
		return;
	}
	await logRelayed(caller, target, entry, startedAt);
	await passBack(response, answer.value);
}

/**
 * `GET /api/cli/github/identity`: who the agent acts as on the connection, for git's author and
 * committer, with GitHub's noreply address for the account rather than the person's own. Needs
 * Read. Never logged, refused or not: `pap git` asks before every git it runs, and nothing reaches
 * GitHub.
 */
export async function handleGitHubIdentityRoute(request: CliRequest, response: Response): Promise<void> {
	const found = await githubTarget(request.cli, namedConnection(request));
	if (found.isErr()) {
		answerApi(response, refusalOf(found.error));
		return;
	}
	const target = found.value;
	if (!target.actions.includes('read')) {
		answerApi(response, {status: 403, message: refusalMessage(target, 'read', 'pap git’s commit author')});
		return;
	}
	const credential = readGitHubCredential(target.connection.credential);
	if (credential.isErr()) {
		answerApi(response, refusalOf(credential.error));
		return;
	}
	const {id, login, name} = credential.value;
	const identity: GitHubIdentity = {login, name: name?.trim() || login, email: `${id}+${login}@users.noreply.github.com`};
	response.json(identity);
}
