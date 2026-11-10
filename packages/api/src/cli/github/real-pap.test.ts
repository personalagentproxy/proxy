import {afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import type {Server} from 'node:http';
import {dirname, join} from 'node:path';

import {GITHUB_TOKEN, githubConnection, logAgentRequest, papToken, resetFixture, startApp, useConnections} from './relay-fixture';

// The `pap` bundle, as a sandbox runs it under plain Node, running the real git and, where it is
// installed, the real gh, through the relay to the fake GitHub (fake-github.ts): no network. gh is
// found as a binary, not a script wrapping it, so nothing of the machine's own sign-in comes in;
// where there is none, its tests are skipped.

const {startFakeGitHub, GIT_DIR, runProgram} = await import('./fake-github');
const {buildPap} = await import('@proxy/cli/build');

setDefaultTimeout(60_000);

const fake = await startFakeGitHub('pap-real-pap-');
const {root, projects, home, git} = fake;
const bin = join(root, 'bin');
const pap = join(bin, 'pap');
const tmp = join(root, 'tmp');
const work = join(root, 'work');
const NODE = spawnSync('node', ['-p', 'process.execPath'], {encoding: 'utf8'}).stdout.trim();

const BASIC = `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`;
const IDENTITY = 'Dana Octo <1234+octo-dana@users.noreply.github.com>';

// The real gh: the first on the PATH that is a program rather than a script around one, or the one
// such a script names (CONDUCTOR_REAL_GH_PATH, Conductor's).
function realGh(): string | null {
	const onPath = spawnSync('which', ['-a', 'gh'], {encoding: 'utf8'}).stdout.split('\n');
	const candidates = [...onPath, process.env.CONDUCTOR_REAL_GH_PATH ?? ''].filter((path) => path !== '' && existsSync(path));
	return candidates.find((path) => !readFileSync(path).subarray(0, 2).equals(Buffer.from('#!'))) ?? null;
}
const GH = realGh();

let app: Server;
let papUrl = '';

beforeAll(async () => {
	const started = await startApp();
	app = started.server;
	papUrl = started.base;
	mkdirSync(bin, {recursive: true});
	mkdirSync(tmp, {recursive: true});
	mkdirSync(work, {recursive: true});
	writeFileSync(pap, (await buildPap()).unwrap().code, {mode: 0o755});
	if (GH !== null) {
		symlinkSync(GH, join(bin, 'gh'));
	}
});

afterAll(() => {
	app.close();
	fake.close();
});

beforeEach(() => {
	resetFixture();
	fake.gitAuthorizations.length = 0;
	fake.apiRequests.length = 0;
	fake.answerApi.current = () => false;
});

// The sandbox's environment: nothing of the machine's, no identity of git's own, gh signed out.
function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: `${bin}:${GIT_DIR}:${dirname(NODE)}:/usr/bin:/bin`,
		HOME: home,
		TMPDIR: tmp,
		GIT_CONFIG_NOSYSTEM: '1',
		PAP_URL: papUrl,
		PAP_TOKEN: papToken(),
		...extra,
	};
}

function runPap(args: string[], cwd = work, env = sandboxEnv()) {
	return runProgram(NODE, [pap, ...args], cwd, env);
}

const repo = (name: string) => join(work, name);

describe('pap git, the real git as the person', () => {
	test('clones with https and SSH URLs, the clone keeping GitHub’s URL and nothing of PAP', async () => {
		const https = await runPap(['git', 'clone', '-q', 'https://github.com/acme/demo', 'https-clone']);
		const ssh = await runPap(['git', 'clone', '-q', 'git@github.com:acme/demo.git', 'ssh-clone']);

		expect(https).toMatchObject({status: 0, stderr: ''});
		expect(ssh).toMatchObject({status: 0, stderr: ''});
		expect(readFileSync(join(repo('https-clone'), 'README.md'), 'utf8')).toBe('demo\n');
		expect(readFileSync(join(repo('ssh-clone'), 'README.md'), 'utf8')).toBe('demo\n');
		expect(new Set(fake.gitAuthorizations)).toEqual(new Set([BASIC]));

		const remotes = await runPap(['git', 'remote', '-v'], repo('https-clone'));
		expect(remotes.stdout).toBe('origin\thttps://github.com/acme/demo (fetch)\norigin\thttps://github.com/acme/demo (push)\n');
		expect((await runPap(['git', '-C', 'ssh-clone', 'remote', 'get-url', 'origin'])).stdout).toBe('git@github.com:acme/demo.git\n');

		const config = await git(['config', '--list', '--show-origin'], repo('https-clone'), {PATH: GIT_DIR, HOME: home, GIT_CONFIG_NOSYSTEM: '1'});
		expect(config.status).toBe(0);
		for (const text of [config.stdout, readFileSync(join(repo('https-clone'), '.git', 'config'), 'utf8')]) {
			expect(text).toMatch(/url ?= ?https:\/\/github\.com\/acme\/demo\n/);
			expect(text).not.toContain('api/cli');
			expect(text).not.toContain('Bearer');
			expect(text).not.toContain(papUrl);
			expect(text).not.toContain('extraheader');
		}
		expect(existsSync(join(home, '.gitconfig'))).toBe(false);
	});

	test('commits as the identity route’s account, and pushes to GitHub with Push', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', ['read', 'push'])]);
		await runPap(['git', 'clone', '-q', 'https://github.com/acme/demo', 'push-clone']);
		const clone = repo('push-clone');
		writeFileSync(join(clone, 'fix.txt'), 'fixed\n');
		await runPap(['git', 'checkout', '-q', '-b', 'fix-login'], clone);
		await runPap(['git', 'add', '.'], clone);

		const committed = await runPap(['git', 'commit', '-q', '-m', 'fix the login'], clone);
		const pushed = await runPap(['git', 'push', '-q', 'origin', 'fix-login'], clone);

		expect(committed).toMatchObject({status: 0, stderr: ''});
		expect((await git(['log', '-1', '--format=%an <%ae>|%cn <%ce>'], clone)).stdout.trim()).toBe(`${IDENTITY}|${IDENTITY}`);
		expect(pushed).toMatchObject({status: 0, stderr: ''});
		const onGitHub = await git(['log', '-1', '--format=%s|%an <%ae>', 'fix-login'], join(projects, 'acme', 'demo.git'));
		expect(onGitHub.stdout.trim()).toBe(`fix the login|${IDENTITY}`);
		expect(new Set(fake.gitAuthorizations)).toEqual(new Set([BASIC]));
		expect(logAgentRequest.mock.calls.map(([entry]) => [entry.collectionId, entry.action, entry.query, entry.outcome])).toContainEqual(['git', 'push', 'fix-login', 'allowed']);
	});

	test('without Push, the push is refused in PAP’s words and nothing reaches GitHub', async () => {
		await runPap(['git', 'clone', '-q', 'https://github.com/acme/demo', 'read-clone']);
		const clone = repo('read-clone');
		await runPap(['git', 'checkout', '-q', '-b', 'not-allowed'], clone);
		writeFileSync(join(clone, 'no.txt'), 'no\n');
		await runPap(['git', 'add', '.'], clone);
		await runPap(['git', 'commit', '-q', '-m', 'no'], clone);
		fake.gitAuthorizations.length = 0;

		const pushed = await runPap(['git', 'push', 'origin', 'not-allowed'], clone);

		expect(pushed.status).not.toBe(0);
		expect(pushed.stderr).toContain('remote error: Not allowed: Push commits (push), which git push needs, on GitHub connection github-1.');
		expect(fake.gitAuthorizations).toEqual([]);
		expect((await git(['branch', '--list', 'not-allowed'], join(projects, 'acme', 'demo.git'))).stdout).toBe('');
	});

	test('with several GitHub connections, --connection names one, and without it git shows the refusal', async () => {
		useConnections([githubConnection('github-1', 'octo-dana'), githubConnection('github-2', 'acme-bot')]);

		const refused = await runPap(['git', 'ls-remote', 'https://github.com/acme/demo']);
		const named = await runPap(['--connection', 'github-2', 'git', 'ls-remote', 'https://github.com/acme/demo']);

		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('You have several GitHub connections: github-1 (octo-dana), github-2 (acme-bot). Name one with pap --connection <id> git … or pap --connection <id> gh …');
		expect(named.status).toBe(0);
		expect(named.stdout).toContain('refs/heads/main');
	});
});

describe.skipIf(GH === null)('pap gh, the real gh as the person', () => {
	const tmpEmpty = () => expect(readdirSync(tmp)).toEqual([]);

	test('gh api reaches GitHub’s API through the socket, with the connection’s token in place of gh’s', async () => {
		const ran = await runPap(['gh', 'api', '/repos/acme/demo', '--jq', '.full_name']);

		expect(ran).toMatchObject({status: 0, stdout: 'acme/demo\n'});
		expect(fake.apiRequests.map(({method, path, authorization}) => [method, path, authorization])).toEqual([['GET', '/repos/acme/demo', `Bearer ${GITHUB_TOKEN}`]]);
		tmpEmpty();
	});

	test('a GraphQL command reaches /graphql', async () => {
		const ran = await runPap(['gh', 'repo', 'view', 'acme/demo', '--json', 'name']);

		expect(ran.stderr).toBe('');
		expect(JSON.parse(ran.stdout)).toEqual({name: 'demo'});
		expect(fake.apiRequests.map(({method, path}) => `${method} ${path}`)).toContain('POST /graphql');
		expect(fake.apiRequests.every(({authorization}) => authorization === `Bearer ${GITHUB_TOKEN}`)).toBe(true);
	});

	test('inside a clone, gh knows the repository by its remote and asks the API', async () => {
		await runPap(['git', 'clone', '-q', 'https://github.com/acme/demo', 'gh-clone']);

		const listed = await runPap(['gh', 'pr', 'list'], repo('gh-clone'));

		expect(listed.stderr).not.toContain('none of the git remotes');
		expect(listed.status).toBe(0);
		expect(fake.apiRequests.some(({path, body}) => path === '/graphql' && body.includes('pullRequests'))).toBe(true);
		tmpEmpty();
	});

	test('gh repo clone runs its git through PAP', async () => {
		const cloned = await runPap(['gh', 'repo', 'clone', 'acme/demo', 'gh-cloned']);

		expect(cloned.status).toBe(0);
		expect(readFileSync(join(repo('gh-cloned'), 'README.md'), 'utf8')).toBe('demo\n');
		expect(fake.gitAuthorizations.length).toBeGreaterThan(0);
		expect(new Set(fake.gitAuthorizations)).toEqual(new Set([BASIC]));
		expect((await git(['remote', 'get-url', 'origin'], repo('gh-cloned'))).stdout.trim()).toBe('https://github.com/acme/demo.git');
		expect(logAgentRequest.mock.calls.map(([entry]) => [entry.collectionId, entry.action, entry.recordTitle])).toContainEqual(['git', 'read', 'acme/demo']);
		tmpEmpty();
	});

	test('a branch pushed with pap git, as gh pushes one, is opened as a pull request with pap gh pr create', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', ['read', 'push', 'write'])]);
		await runPap(['git', 'clone', '-q', 'https://github.com/acme/demo', 'pr-clone']);
		const clone = repo('pr-clone');
		await runPap(['git', 'checkout', '-q', '-b', 'add-docs'], clone);
		writeFileSync(join(clone, 'docs.md'), 'docs\n');
		await runPap(['git', 'add', '.'], clone);
		await runPap(['git', 'commit', '-q', '-m', 'add docs'], clone);

		// As gh pushes a branch for a pull request, its own credential helper in front.
		const pushed = await runPap(['git', '-c', 'credential.helper=', '-c', `credential.helper=!"${GH}" auth git-credential`, 'push', '--set-upstream', 'origin', 'HEAD:refs/heads/add-docs'], clone);
		const created = await runPap(['gh', 'pr', 'create', '--title', 'Add docs', '--body', 'Docs.', '--base', 'main'], clone);

		expect(pushed.status).toBe(0);
		const onGitHub = await git(['log', '-1', '--format=%s|%an <%ae>', 'add-docs'], join(projects, 'acme', 'demo.git'));
		expect(onGitHub.stdout.trim()).toBe(`add docs|${IDENTITY}`);
		expect(new Set(fake.gitAuthorizations)).toEqual(new Set([BASIC]));
		expect(created).toMatchObject({status: 0, stdout: 'https://github.com/acme/demo/pull/2\n'});
		expect(fake.apiRequests.some(({path, body}) => path === '/graphql' && body.includes('createPullRequest'))).toBe(true);
		tmpEmpty();
	});

	test('the git gh runs itself, its credential helper and all, goes through PAP', async () => {
		await runPap(['git', 'clone', '-q', 'https://github.com/acme/demo', 'checkout-clone']);
		await runPap(['git', 'checkout', '-q', '-b', 'elsewhere'], repo('checkout-clone'));
		fake.gitAuthorizations.length = 0;

		const checkedOut = await runPap(['gh', 'pr', 'checkout', '1'], repo('checkout-clone'));

		expect(checkedOut.status).toBe(0);
		expect(fake.gitAuthorizations.length).toBeGreaterThan(0);
		expect(new Set(fake.gitAuthorizations)).toEqual(new Set([BASIC]));
		expect((await git(['branch', '--show-current'], repo('checkout-clone'))).stdout.trim()).toBe('main');
		tmpEmpty();
	});

	test('a write without Change things on GitHub is refused in PAP’s words, before GitHub', async () => {
		const ran = await runPap(['gh', 'api', '-X', 'POST', '/repos/acme/demo/issues', '-f', 'title=Bug']);

		expect(ran.status).not.toBe(0);
		expect(ran.stderr).toContain('Not allowed: Change things on GitHub (write)');
		expect(fake.apiRequests).toEqual([]);
		tmpEmpty();
	});

	test('pap’s own directory and socket are gone after gh fails, and after a signal ends it', async () => {
		const missing = await runPap(['gh', 'api', '/repos/acme/nothing']);
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain('Not Found');
		tmpEmpty();

		let arrived = () => {};
		const waiting = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		fake.answerApi.current = (request) => {
			if (request.path !== '/slow') {
				return false;
			}
			arrived();
			return true;
		};
		const child = spawn(NODE, [pap, 'gh', 'api', '/slow'], {cwd: work, env: sandboxEnv()});
		const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
		await waiting;
		expect(readdirSync(tmp)).toHaveLength(1);
		child.kill('SIGTERM');

		expect(await exited).toBe(143);
		tmpEmpty();
	});

	test('a release upload is refused by pap, saying it isn’t supported, and nothing is sent', async () => {
		fake.answerApi.current = (request, res) => {
			if (!request.path.startsWith('/repos/acme/demo/releases/tags/v1')) {
				return false;
			}
			res
				.writeHead(200, {'content-type': 'application/json'})
				.end(JSON.stringify({id: 1, tag_name: 'v1', assets: [], upload_url: 'https://uploads.github.com/repos/acme/demo/releases/1/assets{?name,label}'}));
			return true;
		};
		writeFileSync(join(work, 'asset.txt'), 'asset\n');

		const ran = await runPap(['gh', 'release', 'upload', 'v1', 'asset.txt', '-R', 'acme/demo']);

		expect(ran.status).not.toBe(0);
		expect(ran.stderr).toContain('Uploading release assets isn’t supported through pap gh yet.');
		expect(fake.apiRequests.map(({path}) => path).filter((path) => path.includes('assets'))).toEqual([]);
		tmpEmpty();
	});

	test('arguments go to gh untouched', async () => {
		const ran = await runPap(['gh', 'pr', 'create', '--help']);

		expect(ran.status).toBe(0);
		expect(ran.stdout).toContain('Create a pull request on GitHub');
		expect(fake.apiRequests).toEqual([]);
	});
});
