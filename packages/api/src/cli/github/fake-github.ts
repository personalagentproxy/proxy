import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {GITHUB_ORIGINS} from './origins';

/**
 * A fake GitHub for the tests that run the real git and gh through the relay (real-git.test.ts,
 * real-pap.test.ts), with no network: its git server is git's own, `git http-backend`, over bare
 * repositories in a temp directory, `acme/demo` among them with one commit on `main`; its API
 * answers what `answerApi` says, by default a repository for `/repos/acme/demo` and, for GraphQL,
 * an answer with every field gh's repository and pull request queries and its
 * mutation to open one read. Both note what they
 * were sent. GITHUB_ORIGINS is pointed at them.
 */

// git itself, from where it keeps its own programs, rather than whatever wraps it on the PATH.
export const GIT_DIR = spawnSync('git', ['--exec-path'], {encoding: 'utf8'}).stdout.trim();
export const GIT = join(GIT_DIR, 'git');

export type Ran = {status: number; stdout: string; stderr: string};

export type ApiRequest = {method: string; path: string; authorization: string; body: string};

// What gh's GraphQL queries about a repository and its pull requests read, in one answer.
const GRAPHQL_ANSWER = {
	data: {
		repository: {
			id: 'R_1',
			name: 'demo',
			nameWithOwner: 'acme/demo',
			owner: {login: 'acme'},
			url: 'https://github.com/acme/demo',
			description: '',
			isPrivate: false,
			isFork: false,
			parent: null,
			hasIssuesEnabled: true,
			viewerPermission: 'WRITE',
			defaultBranchRef: {name: 'main'},
			pullRequests: {totalCount: 0, nodes: [], pageInfo: {hasNextPage: false, endCursor: null}},
			pullRequest: {
				id: 'PR_1',
				number: 1,
				title: 'Fix the login',
				state: 'OPEN',
				url: 'https://github.com/acme/demo/pull/1',
				baseRefName: 'main',
				headRefName: 'main',
				headRepositoryOwner: {login: 'acme'},
				headRepository: {name: 'demo'},
				isCrossRepository: false,
				maintainerCanModify: false,
			},
		},
		createPullRequest: {pullRequest: {id: 'PR_2', number: 2, url: 'https://github.com/acme/demo/pull/2'}},
	},
};

export type FakeGitHub = {
	root: string;
	projects: string;
	home: string;
	/** The Authorization headers its git server was sent. */
	gitAuthorizations: string[];
	apiRequests: ApiRequest[];
	/** Its API's answer to a request; the default where it answers null. */
	answerApi: {current: (request: ApiRequest, res: ServerResponse) => boolean};
	/** The process's own environment for git, with none of the machine's config. */
	gitEnv: (extra?: Record<string, string>) => Record<string, string>;
	git: (args: string[], cwd: string, env?: Record<string, string>) => Promise<Ran>;
	close: () => void;
};

// Runs a program without blocking: the relay answering it is in this process.
export function runProgram(file: string, args: string[], cwd: string, env: Record<string, string>): Promise<Ran> {
	const child = spawn(file, args, {cwd, env});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk: Buffer) => {
		stdout += chunk.toString('utf8');
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString('utf8');
	});
	return new Promise((resolve) => {
		child.on('close', (status, signal) => resolve({status: status ?? (signal === 'SIGTERM' ? 143 : -1), stdout, stderr}));
	});
}

// `git http-backend` as GitHub: the request as CGI, its answer's headers read off before its body is streamed back.
function httpBackend(projects: string, gitEnv: FakeGitHub['gitEnv'], req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? '/', 'http://github.test');
	const backend = spawn(GIT, ['http-backend'], {
		env: {
			...gitEnv(),
			GIT_PROJECT_ROOT: projects,
			GIT_HTTP_EXPORT_ALL: '1',
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'http.receivepack',
			GIT_CONFIG_VALUE_0: 'true',
			REQUEST_METHOD: req.method ?? 'GET',
			PATH_INFO: url.pathname,
			QUERY_STRING: url.search.slice(1),
			CONTENT_TYPE: req.headers['content-type'] ?? '',
			HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
			GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
			REMOTE_ADDR: '127.0.0.1',
		},
	});
	req.pipe(backend.stdin);
	let head = Buffer.alloc(0);
	let started = false;
	backend.stdout.on('data', (chunk: Buffer) => {
		if (started) {
			res.write(chunk);
			return;
		}
		head = Buffer.concat([head, chunk]);
		const end = head.indexOf('\r\n\r\n');
		if (end === -1) {
			return;
		}
		started = true;
		let status = 200;
		for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
			const [name = '', ...rest] = line.split(':');
			const value = rest.join(':').trim();
			if (name.toLowerCase() === 'status') {
				status = Number.parseInt(value, 10);
				continue;
			}
			res.setHeader(name, value);
		}
		res.writeHead(status);
		res.write(head.subarray(end + 4));
	});
	backend.stdout.on('end', () => res.end());
}

function defaultApi(request: ApiRequest, res: ServerResponse): void {
	if (request.method === 'POST' && request.path === '/graphql') {
		res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(GRAPHQL_ANSWER));
		return;
	}
	if (request.path === '/repos/acme/demo') {
		res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({id: 1, name: 'demo', full_name: 'acme/demo', private: false, default_branch: 'main', owner: {login: 'acme'}}));
		return;
	}
	res.writeHead(404, {'content-type': 'application/json'}).end(JSON.stringify({message: 'Not Found'}));
}

async function listen(server: Server): Promise<string> {
	server.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	return `http://localhost:${(server.address() as AddressInfo).port}`;
}

/** The fake GitHub, its repositories under a new temp directory named for `prefix`. */
export async function startFakeGitHub(prefix: string): Promise<FakeGitHub> {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const projects = join(root, 'projects');
	const home = join(root, 'home');
	mkdirSync(join(projects, 'acme'), {recursive: true});
	mkdirSync(home, {recursive: true});
	const gitAuthorizations: string[] = [];
	const apiRequests: ApiRequest[] = [];
	const answerApi: FakeGitHub['answerApi'] = {current: () => false};

	const gitEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
		PATH: `${GIT_DIR}:${process.env.PATH ?? ''}`,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
		...extra,
	});
	const git = (args: string[], cwd: string, env: Record<string, string> = gitEnv()) => runProgram(GIT, args, cwd, env);

	const gitServer = createServer((req, res) => {
		gitAuthorizations.push(req.headers.authorization ?? '');
		httpBackend(projects, gitEnv, req, res);
	});
	const apiServer = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});
		req.on('end', () => {
			const request = {method: req.method ?? 'GET', path: req.url ?? '/', authorization: req.headers.authorization ?? '', body};
			apiRequests.push(request);
			if (!answerApi.current(request, res)) {
				defaultApi(request, res);
			}
		});
	});
	GITHUB_ORIGINS.git = await listen(gitServer);
	GITHUB_ORIGINS.api = await listen(apiServer);

	const seed = join(root, 'seed');
	await git(['init', '-q', '-b', 'main', seed], root);
	writeFileSync(join(seed, 'README.md'), 'demo\n');
	await git(['add', '.'], seed);
	await git(['commit', '-q', '-m', 'first'], seed);
	await git(['clone', '-q', '--bare', seed, join(projects, 'acme', 'demo.git')], root);

	return {
		root,
		projects,
		home,
		gitAuthorizations,
		apiRequests,
		answerApi,
		gitEnv,
		git,
		close: () => {
			gitServer.closeAllConnections();
			apiServer.closeAllConnections();
			gitServer.close();
			apiServer.close();
			rmSync(root, {recursive: true, force: true});
		},
	};
}
