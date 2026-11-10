import {describe, expect, test} from 'bun:test';

import {Err, Ok} from 'ts-results-es';

import {fakeIo} from './fake-io';
import {gitEnv, gitSubcommand} from './git';
import type {Env} from './io';
import {run} from './run';

const RELAY = 'https://app.example.com/api/cli/github/git/';

describe('gitSubcommand', () => {
	test('skips git’s own options, those taking a value in either form', () => {
		const cases: Array<[string[], string | null]> = [
			[['push'], 'push'],
			[['-C', 'dir', '-c', 'a=b', 'push', 'origin'], 'push'],
			[['--git-dir=x', 'fetch'], 'fetch'],
			[['--git-dir', 'x', 'fetch'], 'fetch'],
			[['--work-tree', 'w', '--namespace', 'n', 'status'], 'status'],
			[['--work-tree=w', '--namespace=n', 'status'], 'status'],
			[['--config-env', 'a.b=HOME', 'clone'], 'clone'],
			[['--config-env=a.b=HOME', 'clone'], 'clone'],
			[['--super-prefix', 'sub/', 'fetch'], 'fetch'],
			[['--attr-source', 'HEAD', 'diff'], 'diff'],
			[['--exec-path=/x', 'pull'], 'pull'],
			[['-p', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', 'log'], 'log'],
			[['-c', 'push', 'status'], 'status'],
			[['-C', 'push'], null],
			[[], null],
			[['--version'], null],
			[['-v'], null],
			[['--help', 'push'], null],
			[['-h'], null],
			[['--exec-path'], null],
			[['--html-path'], null],
			[['--list-cmds=main'], null],
		];
		for (const [args, name] of cases) {
			expect([args, gitSubcommand(args)?.name ?? null]).toEqual([args, name]);
		}
	});

	test('gives the arguments after the subcommand', () => {
		expect(gitSubcommand(['-C', 'd', 'remote', '-v', 'update'])).toEqual({
			name: 'remote',
			rest: ['-v', 'update'],
		});
	});
});

describe('gitEnv', () => {
	const relay = {base: 'https://app.example.com', token: 'pap_token', connection: undefined};

	test('rewrites GitHub’s URLs, both SSH forms too, and sends the token to the relay alone', () => {
		expect(gitEnv({PATH: '/bin'}, {relay, identity: null})).toEqual({
			PATH: '/bin',
			GIT_CONFIG_COUNT: '4',
			GIT_CONFIG_KEY_0: `url.${RELAY}.insteadOf`,
			GIT_CONFIG_VALUE_0: 'https://github.com/',
			GIT_CONFIG_KEY_1: `url.${RELAY}.insteadOf`,
			GIT_CONFIG_VALUE_1: 'git@github.com:',
			GIT_CONFIG_KEY_2: `url.${RELAY}.insteadOf`,
			GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
			GIT_CONFIG_KEY_3: `http.${RELAY}.extraHeader`,
			GIT_CONFIG_VALUE_3: 'Authorization: Bearer pap_token',
			GIT_TERMINAL_PROMPT: '0',
		});
	});

	test('comes after config the environment has, and names the connection', () => {
		const env = gitEnv(
			{
				GIT_CONFIG_COUNT: '2',
				GIT_CONFIG_KEY_0: 'a.b',
				GIT_CONFIG_VALUE_0: '1',
				GIT_CONFIG_KEY_1: 'c.d',
				GIT_CONFIG_VALUE_1: '2',
			},
			{relay: {...relay, connection: 'github-2'}, identity: null},
		);

		expect(env.GIT_CONFIG_COUNT).toBe('7');
		expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1]).toEqual(['a.b', 'c.d']);
		expect(env.GIT_CONFIG_VALUE_2).toBe('https://github.com/');
		expect(env.GIT_CONFIG_KEY_6).toBe(`http.${RELAY}.extraHeader`);
		expect(env.GIT_CONFIG_VALUE_6).toBe('x-pap-connection: github-2');
	});

	test('the identity fills in only what the environment doesn’t set', () => {
		const identity = {name: 'Dana Octo', email: '1+octo-dana@users.noreply.github.com'};

		expect(gitEnv({}, {relay: null, identity})).toEqual({
			GIT_AUTHOR_NAME: 'Dana Octo',
			GIT_AUTHOR_EMAIL: '1+octo-dana@users.noreply.github.com',
			GIT_COMMITTER_NAME: 'Dana Octo',
			GIT_COMMITTER_EMAIL: '1+octo-dana@users.noreply.github.com',
		});
		expect(
			gitEnv(
				{GIT_AUTHOR_NAME: 'Bot', GIT_COMMITTER_EMAIL: 'bot@example.com'},
				{relay: null, identity},
			),
		).toEqual({
			GIT_AUTHOR_NAME: 'Bot',
			GIT_AUTHOR_EMAIL: '1+octo-dana@users.noreply.github.com',
			GIT_COMMITTER_NAME: 'Dana Octo',
			GIT_COMMITTER_EMAIL: 'bot@example.com',
		});
	});
});

describe('pap git', () => {
	const IDENTITY = {
		login: 'octo-dana',
		name: 'Dana Octo',
		email: '1+octo-dana@users.noreply.github.com',
	};

	function harness(options: {env?: Env; identity?: () => Response} = {}) {
		const requests: Array<{url: string; headers: Headers}> = [];
		const fake = fakeIo({
			env: options.env ?? {
				PATH: '/shim:/usr/bin',
				PAP_URL: 'https://app.example.com',
				PAP_TOKEN: 'pap_token',
			},
			executables: ['/shim/git', '/usr/bin/git'],
			fetch: async (url, init) => {
				requests.push({url, headers: new Headers(init.headers)});
				return options.identity?.() ?? Response.json(IDENTITY);
			},
			spawn: async () => Ok(7),
		});
		return {...fake, requests, pap: (...args: string[]) => run(args, fake.io, 'abc123')};
	}

	test('runs the first git on the PATH with the arguments untouched, and gives back its exit code', async () => {
		const {spawned, pap} = harness();

		expect(await pap('git', 'push', '--force', 'origin', 'main')).toBe(7);
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.file).toBe('/shim/git');
		expect(spawned[0]?.args).toEqual(['push', '--force', 'origin', 'main']);
		expect(spawned[0]?.env.GIT_CONFIG_VALUE_3).toBe('Authorization: Bearer pap_token');
	});

	test('every subcommand goes through the relay, a partial clone’s checkout too, but git remote showing the URLs', async () => {
		const cases: Array<[string[], boolean]> = [
			[['checkout', 'main'], true],
			[['-C', 'repo', 'show', 'HEAD'], true],
			[['status'], true],
			[['remote', 'show', 'origin'], true],
			[['remote', 'update'], true],
			[['remote', 'add', '-f', 'up', 'https://github.com/a/b'], true],
			[['remote'], false],
			[['remote', '-v'], false],
			[['-C', 'repo', 'remote', 'get-url', 'origin'], false],
		];
		for (const [args, relayed] of cases) {
			const {spawned, pap} = harness();
			await pap('git', ...args);
			expect([args, spawned[0]?.env.GIT_CONFIG_COUNT !== undefined]).toEqual([args, relayed]);
		}
	});

	test('looks past the shim pap gh puts first on gh’s PATH', async () => {
		const {spawned, pap} = harness({
			env: {
				PATH: '/shim:/usr/bin',
				PAP_GIT_SHIM: '/shim/',
				PAP_URL: 'https://app.example.com',
				PAP_TOKEN: 't',
			},
		});

		await pap('git', 'status');
		expect(spawned[0]?.file).toBe('/usr/bin/git');
	});

	test('a commit is made as the identity route’s account, for the connection named', async () => {
		const {spawned, requests, pap} = harness();

		expect(await pap('--connection', 'github-2', 'git', '-C', 'repo', 'commit', '-m', 'Fix')).toBe(
			7,
		);
		expect(
			requests.map(({url, headers}) => [
				url,
				headers.get('authorization'),
				headers.get('x-pap-connection'),
			]),
		).toEqual([
			['https://app.example.com/api/cli/github/identity', 'Bearer pap_token', 'github-2'],
		]);
		const env = spawned[0]?.env ?? {};
		expect([
			env.GIT_AUTHOR_NAME,
			env.GIT_AUTHOR_EMAIL,
			env.GIT_COMMITTER_NAME,
			env.GIT_COMMITTER_EMAIL,
		]).toEqual(['Dana Octo', IDENTITY.email, 'Dana Octo', IDENTITY.email]);
		expect(env.PAP_GITHUB_CONNECTION).toBe('github-2');
		expect(env.GIT_CONFIG_VALUE_4).toBe('x-pap-connection: github-2');
		expect(spawned[0]?.args).toEqual(['-C', 'repo', 'commit', '-m', 'Fix']);
	});

	test('pull gets both, and the connection from the environment', async () => {
		const {spawned, requests, pap} = harness({
			env: {
				PATH: '/usr/bin',
				PAP_URL: 'https://app.example.com/',
				PAP_TOKEN: 't',
				PAP_GITHUB_CONNECTION: 'github-3',
			},
		});

		await pap('git', 'pull');
		expect(requests[0]?.headers.get('x-pap-connection')).toBe('github-3');
		expect(spawned[0]?.env.GIT_CONFIG_VALUE_4).toBe('x-pap-connection: github-3');
		expect(spawned[0]?.env.GIT_CONFIG_KEY_0).toBe(`url.${RELAY}.insteadOf`);
		expect(spawned[0]?.env.GIT_AUTHOR_NAME).toBe('Dana Octo');
	});

	test('an identity the environment sets in full is not asked for', async () => {
		const own = {
			GIT_AUTHOR_NAME: 'a',
			GIT_AUTHOR_EMAIL: 'b',
			GIT_COMMITTER_NAME: 'c',
			GIT_COMMITTER_EMAIL: 'd',
		};
		const {spawned, requests, pap} = harness({
			env: {PATH: '/usr/bin', PAP_URL: 'https://app.example.com', PAP_TOKEN: 't', ...own},
		});

		await pap('git', 'commit', '-m', 'x');
		expect(requests).toEqual([]);
		expect(spawned[0]?.env).toMatchObject(own);
	});

	test('where PAP won’t say who to commit as, git runs all the same, as git would commit', async () => {
		const forbidden = harness({
			identity: () =>
				Response.json({message: 'Not allowed: Read repositories (read).'}, {status: 403}),
		});
		const badToken = harness({
			identity: () => Response.json({message: 'PAP_TOKEN has expired.'}, {status: 401}),
		});

		expect(await forbidden.pap('git', 'commit', '-m', 'x')).toBe(7);
		expect(await badToken.pap('git', 'tag', '-a', 'v1', '-m', 'v1')).toBe(7);
		for (const {spawned, output} of [forbidden, badToken]) {
			expect(spawned[0]?.env.GIT_AUTHOR_NAME).toBeUndefined();
			expect(output.err).toBe('');
		}
	});

	test('git with no subcommand asks nothing', async () => {
		const {requests, pap} = harness();

		expect(await pap('git', '--version')).toBe(7);
		expect(requests).toEqual([]);
	});

	test('without PAP_URL and PAP_TOKEN, git isn’t run', async () => {
		const {spawned, output, pap} = harness({env: {PATH: '/usr/bin'}});

		expect(await pap('git', 'status')).toBe(3);
		expect(output.err).toBe(
			'pap: PAP_URL and PAP_TOKEN are not set: run pap in a sandbox_exec command with pap: true.\n',
		);
		expect(spawned).toEqual([]);
	});

	test('without arguments, a note of pap’s own; without git, one line', async () => {
		const {output, spawned, pap} = harness();
		expect(await pap('git')).toBe(0);
		expect(output.out).toContain('plain git is signed out');
		expect(output.out).toContain('pap --connection <id> git <args>');
		expect(spawned).toEqual([]);

		const none = fakeIo({env: {PATH: '/nowhere'}});
		expect(await run(['git', 'status'], none.io, 'x')).toBe(1);
		expect(none.output.err).toBe('pap: git is not installed here.\n');
	});

	test('a git that can’t be started is one line', async () => {
		const broken = fakeIo({
			env: {PATH: '/usr/bin', PAP_URL: 'https://app.example.com', PAP_TOKEN: 't'},
			executables: ['/usr/bin/git'],
			spawn: async () => Err(new Error('EACCES')),
		});
		expect(await run(['git', 'status'], broken.io, 'x')).toBe(1);
		expect(broken.output.err).toBe('pap: could not run /usr/bin/git: EACCES\n');
	});

	test('--connection goes before git or gh, with an id', async () => {
		const {output, spawned, pap} = harness();

		expect(await pap('--connection', 'github-2', 'connections')).toBe(2);
		expect(await pap('--connection')).toBe(2);
		expect(await pap('--connection=', 'git', 'status')).toBe(2);
		expect(output.err.trimEnd().split('\n')).toEqual(
			Array(3).fill(
				'pap: --connection <id> goes before git or gh: pap --connection <id> git <args>',
			),
		);
		expect(spawned).toEqual([]);
		expect(await pap('--connection=github-9', 'git', 'status')).toBe(7);
		expect(spawned[0]?.env.PAP_GITHUB_CONNECTION).toBe('github-9');
	});
});
