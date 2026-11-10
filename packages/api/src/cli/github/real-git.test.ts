import {afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {Ok} from 'ts-results-es';

import {agentRow, getAgentById, GITHUB_TOKEN, githubConnection, logAgentRequest, papToken, resetFixture, startApp, useConnections} from './relay-fixture';

// The real git, cloning, committing, pushing and fetching through the relay, with the config `pap
// git` gives it for one invocation, against a fake GitHub that is git's own server, `git
// http-backend`, over a bare repository in a temp directory: no network.

const {GITHUB_ORIGINS} = await import('./origins');

// Each test runs git several times, each a few processes.
setDefaultTimeout(30_000);

const root = mkdtempSync(join(tmpdir(), 'pap-real-git-'));
const projects = join(root, 'projects');
const home = join(root, 'home');

// The Authorization headers the fake GitHub was sent, to check the PAP token never reached it.
const authorizations: string[] = [];

// git itself, from where it keeps its own programs, rather than whatever wraps it on the PATH.
const gitDir = spawnSync('git', ['--exec-path'], {encoding: 'utf8'}).stdout.trim();
const GIT = join(gitDir, 'git');

// The process's own environment for git, with none of the machine's config.
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: `${gitDir}:${process.env.PATH ?? ''}`,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
		...extra,
	};
}

// Run without blocking: the relay answering git is in this process.
function git(args: string[], cwd: string, env: Record<string, string> = gitEnv()): Promise<{status: number; stdout: string; stderr: string}> {
	const child = spawn(GIT, args, {cwd, env});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk: Buffer) => {
		stdout += chunk.toString('utf8');
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString('utf8');
	});
	return new Promise((resolve) => {
		child.on('close', (status) => resolve({status: status ?? -1, stdout, stderr}));
	});
}

// `git http-backend` as GitHub: the request as CGI, its answer's headers read off before its body is streamed back.
function httpBackend(req: IncomingMessage, res: ServerResponse): void {
	authorizations.push(req.headers.authorization ?? '');
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

let app: Server;
let github: Server;
let papUrl = '';

beforeAll(async () => {
	const started = await startApp();
	app = started.server;
	papUrl = started.base;
	github = createServer(httpBackend).listen(0);
	await new Promise((resolve) => github.once('listening', resolve));
	GITHUB_ORIGINS.git = `http://localhost:${(github.address() as AddressInfo).port}`;

	// acme/demo on the fake GitHub, with one commit on main.
	const seed = join(root, 'seed');
	spawnSync('mkdir', ['-p', seed, home, join(projects, 'acme')]);
	await git(['init', '-q', '-b', 'main', seed], root);
	writeFileSync(join(seed, 'README.md'), 'demo\n');
	await git(['add', '.'], seed);
	await git(['commit', '-q', '-m', 'first'], seed);
	await git(['clone', '-q', '--bare', seed, join(projects, 'acme', 'demo.git')], root);
});

afterAll(() => {
	app.close();
	github.close();
	rmSync(root, {recursive: true, force: true});
});

beforeEach(() => {
	resetFixture();
	authorizations.length = 0;
});

// What `pap git` gives git for one invocation: GitHub's URLs rewritten to the relay, and the
// command's token sent to the relay alone.
function papGitEnv(): Record<string, string> {
	const relay = `${papUrl}/api/cli/github/git/`;
	return gitEnv({
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: `url.${relay}.insteadOf`,
		GIT_CONFIG_VALUE_0: 'https://github.com/',
		GIT_CONFIG_KEY_1: `http.${relay}.extraHeader`,
		GIT_CONFIG_VALUE_1: `Authorization: Bearer ${papToken()}`,
	});
}

describe('the real git through the relay', () => {
	test('clones, commits, pushes and fetches as the person, the clone keeping GitHub’s URL', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', ['read', 'push'])]);
		const clone = join(root, 'clone');
		const cloned = await git(['clone', 'https://github.com/acme/demo', clone], root, papGitEnv());
		expect(cloned.status).toBe(0);
		expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('demo\n');

		writeFileSync(join(clone, 'fix.txt'), 'fixed\n');
		await git(['checkout', '-q', '-b', 'fix-login'], clone);
		await git(['add', '.'], clone);
		await git(['commit', '-q', '-m', 'fix the login'], clone);
		const pushed = await git(['push', 'origin', 'fix-login'], clone, papGitEnv());
		expect(pushed.status).toBe(0);
		const onGitHub = await git(['log', '--format=%s', 'fix-login'], join(projects, 'acme', 'demo.git'));
		expect(onGitHub.stdout.trim().split('\n')[0]).toBe('fix the login');

		// Up to date, git only lists the refs, which isn't logged; once someone else pushed, it fetches.
		expect((await git(['fetch', 'origin'], clone, papGitEnv())).status).toBe(0);
		const seed = join(root, 'seed');
		writeFileSync(join(seed, 'other.txt'), 'other\n');
		await git(['add', '.'], seed);
		await git(['commit', '-q', '-m', 'someone else'], seed);
		await git(['push', '-q', join(projects, 'acme', 'demo.git'), 'main'], seed);
		const fetched = await git(['fetch', 'origin'], clone, papGitEnv());
		expect(fetched.status).toBe(0);
		expect((await git(['log', '--format=%s', '-1', 'origin/main'], clone)).stdout.trim()).toBe('someone else');

		const config = readFileSync(join(clone, '.git', 'config'), 'utf8');
		expect((await git(['remote', 'get-url', 'origin'], clone)).stdout.trim()).toBe('https://github.com/acme/demo');
		expect(config).not.toContain('api/cli');
		expect(config).not.toContain('Bearer');
		expect(config).not.toContain(papUrl);

		// GitHub was sent the connection's token as git's password, never the command's.
		expect(authorizations.length).toBeGreaterThan(0);
		expect(new Set(authorizations)).toEqual(new Set([`Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`]));

		const entries = logAgentRequest.mock.calls.map(([entry]) => [entry.collectionId, entry.action, entry.recordTitle, entry.query, entry.outcome, entry.via]);
		expect(entries).toEqual([
			['git', 'read', 'acme/demo', null, 'allowed', 'cli'],
			['git', 'push', 'acme/demo', 'fix-login', 'allowed', 'cli'],
			['git', 'read', 'acme/demo', null, 'allowed', 'cli'],
		]);
	});

	test('a push without Push is refused, in words git shows, and nothing reaches GitHub', async () => {
		const clone = join(root, 'clone-read');
		expect((await git(['clone', '-q', 'https://github.com/acme/demo', clone], root, papGitEnv())).status).toBe(0);
		await git(['checkout', '-q', '-b', 'not-allowed'], clone);
		writeFileSync(join(clone, 'no.txt'), 'no\n');
		await git(['add', '.'], clone);
		await git(['commit', '-q', '-m', 'no'], clone);
		authorizations.length = 0;

		const pushed = await git(['push', 'origin', 'not-allowed'], clone, papGitEnv());

		expect(pushed.status).not.toBe(0);
		expect(pushed.stderr).toContain('remote error: Not allowed: Push commits (push), which git push needs, on GitHub connection github-1. The person who made this login can allow it.');
		expect(authorizations).toEqual([]);
		expect((await git(['branch', '--list', 'not-allowed'], join(projects, 'acme', 'demo.git'))).stdout).toBe('');
		expect(logAgentRequest).toHaveBeenLastCalledWith(expect.objectContaining({collectionId: 'git', action: 'push', recordTitle: 'acme/demo', outcome: 'denied', via: 'cli'}));
	});

	test('refused at the POST rather than info/refs, as where the setting changed between them, git shows the words too', async () => {
		const clone = join(root, 'clone-between');
		expect((await git(['clone', '-q', 'https://github.com/acme/demo', clone], root, papGitEnv())).status).toBe(0);
		await git(['checkout', '-q', '-b', 'between'], clone);
		writeFileSync(join(clone, 'between.txt'), 'between\n');
		await git(['add', '.'], clone);
		await git(['commit', '-q', '-m', 'between'], clone);
		getAgentById.mockResolvedValueOnce(Ok(agentRow([{connectionId: 'github-1', actionId: 'push', allowed: true}])));
		getAgentById.mockResolvedValueOnce(Ok(agentRow([])));

		const pushed = await git(['push', 'origin', 'between'], clone, papGitEnv());

		expect(pushed.status).not.toBe(0);
		expect(pushed.stderr).toContain('Not allowed: Push commits (push)');

		getAgentById.mockResolvedValueOnce(Ok(agentRow([])));
		getAgentById.mockResolvedValueOnce(Ok(agentRow([{connectionId: 'github-1', actionId: 'read', allowed: false}])));
		const fetched = await git(['fetch', 'origin'], clone, papGitEnv());

		expect(fetched.status).not.toBe(0);
		expect(fetched.stderr).toContain('Not allowed: Read repositories (read)');
	});

	test('a clone without Read is refused in words git shows', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', [])], [{connectionId: 'github-1', actionId: 'push', allowed: true}]);
		const cloned = await git(['clone', '-q', 'https://github.com/acme/demo', join(root, 'clone-none')], root, papGitEnv());

		expect(cloned.status).not.toBe(0);
		expect(cloned.stderr).toContain('remote error:');
		expect(cloned.stderr).toContain('GitHub');
	});

	test('a token that is no good is refused in words git shows, never a prompt for a password', async () => {
		const env = {...papGitEnv(), GIT_CONFIG_VALUE_1: 'Authorization: Bearer pap_nonsense.nonsense'};
		const cloned = await git(['clone', '-q', 'https://github.com/acme/demo', join(root, 'clone-bad')], root, env);

		expect(cloned.status).not.toBe(0);
		expect(cloned.stderr).toContain('remote error: PAP_TOKEN is not a valid token.');
		expect(cloned.stderr).not.toContain('Username');
	});
});
