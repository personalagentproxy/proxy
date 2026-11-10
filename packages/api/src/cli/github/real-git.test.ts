import {afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {readFileSync, writeFileSync} from 'node:fs';
import type {Server} from 'node:http';
import {join} from 'node:path';

import {Ok} from 'ts-results-es';

import {agentRow, getAgentById, GITHUB_TOKEN, githubConnection, logAgentRequest, papToken, resetFixture, startApp, useConnections} from './relay-fixture';

// The real git, cloning, committing, pushing and fetching through the relay, with the config `pap
// git` gives it for one invocation, against the fake GitHub (fake-github.ts): no network.

const {startFakeGitHub} = await import('./fake-github');

// Each test runs git several times, each a few processes.
setDefaultTimeout(30_000);

const fake = await startFakeGitHub('pap-real-git-');
const {root, projects, git, gitEnv} = fake;
// The Authorization headers the fake GitHub was sent, to check the PAP token never reached it.
const authorizations = fake.gitAuthorizations;

let app: Server;
let papUrl = '';

beforeAll(async () => {
	const started = await startApp();
	app = started.server;
	papUrl = started.base;
});

afterAll(() => {
	app.close();
	fake.close();
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

		// Each fetch is logged, up to date or not: git asks for the refs once for each.
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
		expect(pushed.stderr).toContain('remote error: Not allowed: Push to branches (push), which git push needs, on GitHub connection github-1. The person who made this login can allow it.');
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
		expect(pushed.stderr).toContain('Not allowed: Push to branches (push)');

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
