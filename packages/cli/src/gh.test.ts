import {describe, expect, test} from 'bun:test';

import {Err} from 'ts-results-es';

import {fakeIo} from './fake-io';
import {GH_TOKEN_PLACEHOLDER, ghRelay, ghRoute} from './gh';
import type {Env} from './io';
import {run} from './run';

const BASE = 'https://app.example.com';
const SERVER = {base: BASE, token: 'pap_token'};

describe('ghRoute', () => {
	test('GitHub’s API goes to PAP’s relay; uploads are not supported; any other host is fetched directly', () => {
		expect(ghRoute('api.github.com', '/repos/acme/demo?per_page=1', BASE)).toEqual({
			kind: 'pap',
			url: `${BASE}/api/cli/github/api/repos/acme/demo?per_page=1`,
		});
		expect(ghRoute('API.GitHub.com:443', '/graphql', BASE)).toEqual({
			kind: 'pap',
			url: `${BASE}/api/cli/github/api/graphql`,
		});
		expect(
			ghRoute('uploads.github.com', '/repos/acme/demo/releases/1/assets?name=a.zip', BASE),
		).toEqual({kind: 'uploads'});
		expect(ghRoute('codeload.github.com', '/acme/demo/tar.gz/main', BASE)).toEqual({
			kind: 'direct',
			url: 'https://codeload.github.com/acme/demo/tar.gz/main',
		});
		expect(ghRoute('github.com', '/acme/demo', BASE)).toEqual({
			kind: 'direct',
			url: 'https://github.com/acme/demo',
		});
	});
});

describe('ghRelay', () => {
	function relay(answer: () => Response | Promise<Response>, connection?: string) {
		const sent: Array<{
			url: string;
			method: string;
			headers: Headers;
			body: string | null;
			redirect: RequestRedirect | undefined;
		}> = [];
		const {io} = fakeIo({
			fetch: async (url, init) => {
				const body = init.body ? await new Response(init.body).text() : null;
				sent.push({
					url,
					method: init.method ?? 'GET',
					headers: new Headers(init.headers),
					body,
					redirect: init.redirect,
				});
				return answer();
			},
		});
		return {sent, handle: ghRelay(io, SERVER, connection)};
	}

	test('sends an API request to PAP with the command’s token instead of gh’s, method, headers and body as they were', async () => {
		const {sent, handle} = relay(
			() => Response.json({number: 1}, {status: 201, headers: {'x-github-request-id': 'abc'}}),
			'github-2',
		);
		const request = new Request('http://api.github.com/repos/acme/demo/issues', {
			method: 'POST',
			headers: {
				authorization: `token ${GH_TOKEN_PLACEHOLDER}`,
				'content-type': 'application/json',
				accept: 'application/vnd.github+json',
				'content-length': '15',
			},
			body: '{"title":"Bug"}',
		});

		const response = await handle(request);

		expect(sent).toEqual([
			{
				url: `${BASE}/api/cli/github/api/repos/acme/demo/issues`,
				method: 'POST',
				headers: expect.any(Headers),
				body: '{"title":"Bug"}',
				redirect: 'manual',
			},
		]);
		const headers = Object.fromEntries(sent[0]?.headers ?? []);
		expect(headers).toEqual({
			authorization: 'Bearer pap_token',
			'x-pap-connection': 'github-2',
			'content-type': 'application/json',
			accept: 'application/vnd.github+json',
		});
		expect(response.status).toBe(201);
		expect(response.headers.get('x-github-request-id')).toBe('abc');
		expect(await response.json()).toEqual({number: 1});
	});

	test('passes the answer back decoded, without the encoding it no longer has, and a redirect as it is', async () => {
		const gzipped = relay(
			() =>
				new Response('{"ok":true}', {
					headers: {
						'content-encoding': 'gzip',
						'content-length': '99',
						'content-type': 'application/json',
					},
				}),
		);
		const answer = await gzipped.handle(new Request('http://api.github.com/user'));
		expect(answer.headers.get('content-encoding')).toBeNull();
		expect(answer.headers.get('content-length')).toBeNull();
		expect(await answer.text()).toBe('{"ok":true}');
		expect(gzipped.sent[0]?.body).toBeNull();

		const redirected = relay(
			() =>
				new Response(null, {
					status: 302,
					headers: {location: 'https://codeload.github.com/acme/demo/tar.gz/main'},
				}),
		);
		const moved = await redirected.handle(
			new Request('http://api.github.com/repos/acme/demo/tarball'),
		);
		expect(moved.status).toBe(302);
		expect(moved.headers.get('location')).toBe('https://codeload.github.com/acme/demo/tar.gz/main');
	});

	test('another host is fetched directly with no credential at all', async () => {
		const {sent, handle} = relay(() => new Response('bytes'));

		const response = await handle(
			new Request('http://objects.githubusercontent.com/x?sig=1', {
				headers: {authorization: 'token placeholder', accept: '*/*'},
			}),
		);

		expect(sent[0]?.url).toBe('https://objects.githubusercontent.com/x?sig=1');
		expect(Object.fromEntries(sent[0]?.headers ?? [])).toEqual({accept: '*/*'});
		expect(await response.text()).toBe('bytes');
	});

	test('uploads are answered here as GitHub words an error, and nothing is sent', async () => {
		const {sent, handle} = relay(() => new Response('never'));

		const response = await handle(
			new Request('http://uploads.github.com/repos/acme/demo/releases/1/assets?name=a.zip', {
				method: 'POST',
				body: 'zip',
			}),
		);

		expect(response.status).toBe(422);
		expect(((await response.json()) as {message: string}).message).toBe(
			'Uploading release assets isn’t supported through pap gh yet.',
		);
		expect(sent).toEqual([]);
	});

	test('PAP out of reach is a 502 in GitHub’s shape', async () => {
		const {handle} = relay(() => Promise.reject(new TypeError('fetch failed')));

		const response = await handle(new Request('http://api.github.com/user'));

		expect(response.status).toBe(502);
		expect(((await response.json()) as {message: string}).message).toBe(
			'Could not reach PAP at https://app.example.com: fetch failed. Try again.',
		);
	});
});

describe('pap gh', () => {
	const ENV: Env = {
		PATH: '/usr/bin',
		PAP_URL: 'https://app.example.com/',
		PAP_TOKEN: 'pap_token',
		HOME: '/home/user',
	};

	test('runs gh with a config of its own, a placeholder token and the git shim, serving its socket until it exits, then removes it all', async () => {
		const fake = fakeIo({env: ENV, executables: ['/usr/bin/gh']});

		expect(
			await run(['--connection', 'github-2', 'gh', 'pr', 'create', '--help'], fake.io, 'x'),
		).toBe(0);

		expect(fake.spawned).toHaveLength(1);
		const [ran] = fake.spawned;
		expect(ran?.file).toBe('/usr/bin/gh');
		expect(ran?.args).toEqual(['pr', 'create', '--help']);
		expect(ran?.env).toEqual({
			...ENV,
			PAP_GITHUB_CONNECTION: 'github-2',
			GH_CONFIG_DIR: '/tmp/pap-1',
			GH_TOKEN: GH_TOKEN_PLACEHOLDER,
			GH_PROMPT_DISABLED: '1',
			GH_NO_UPDATE_NOTIFIER: '1',
			GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
			PATH: '/tmp/pap-1/bin:/usr/bin',
			PAP_GIT_SHIM: '/tmp/pap-1/bin',
		});
		expect(Object.fromEntries(fake.files)).toEqual({
			'/tmp/pap-1/config.yml': {
				text: 'http_unix_socket: "/tmp/pap-1/s"\ngit_protocol: https\nprompt: disabled\ntelemetry: disabled\n',
				mode: 0o600,
			},
			'/tmp/pap-1/bin/git': {
				text: "#!/bin/sh\nexec '/usr/bin/node' '/home/user/.local/bin/pap' git \"$@\"\n",
				mode: 0o755,
			},
		});
		expect(fake.servers.map(({path, closed}) => ({path, closed}))).toEqual([
			{path: '/tmp/pap-1/s', closed: true},
		]);
		expect(fake.removed).toEqual(['/tmp/pap-1']);
	});

	test('who commits are made as is asked for once and given to gh, so the gits it runs don’t ask', async () => {
		const asked: string[] = [];
		const fake = fakeIo({
			env: ENV,
			executables: ['/usr/bin/gh'],
			fetch: async (url) => {
				asked.push(url);
				return Response.json({
					login: 'octo-dana',
					name: 'Dana Octo',
					email: '1+octo-dana@users.noreply.github.com',
				});
			},
		});

		expect(await run(['gh', 'pr', 'create', '--fill'], fake.io, 'x')).toBe(0);
		expect(asked).toEqual(['https://app.example.com/api/cli/github/identity']);
		expect(fake.spawned[0]?.env).toMatchObject({
			GIT_AUTHOR_NAME: 'Dana Octo',
			GIT_AUTHOR_EMAIL: '1+octo-dana@users.noreply.github.com',
			GIT_COMMITTER_NAME: 'Dana Octo',
			GIT_COMMITTER_EMAIL: '1+octo-dana@users.noreply.github.com',
		});
	});

	test('gh’s exit code is pap’s, and a gh that can’t be started still has its directory removed', async () => {
		const broken = fakeIo({
			env: ENV,
			executables: ['/usr/bin/gh'],
			spawn: async () => Err(new Error('EACCES')),
		});

		expect(await run(['gh', 'repo', 'view'], broken.io, 'x')).toBe(1);
		expect(broken.output.err).toBe('pap: could not run gh: EACCES\n');
		expect(broken.servers[0]?.closed).toBe(true);
		expect(broken.removed).toEqual(['/tmp/pap-1']);
	});

	test('without gh, or PAP_URL and PAP_TOKEN, one line and nothing made', async () => {
		const missing = fakeIo({env: ENV});
		expect(await run(['gh', 'repo', 'view'], missing.io, 'x')).toBe(1);
		expect(missing.output.err).toBe(
			'pap: gh is not installed here: install GitHub’s gh, then run pap gh again.\n',
		);

		const signedOut = fakeIo({env: {PATH: '/usr/bin'}, executables: ['/usr/bin/gh']});
		expect(await run(['gh', 'repo', 'view'], signedOut.io, 'x')).toBe(3);
		expect([
			...missing.files,
			...signedOut.files,
			...missing.spawned,
			...signedOut.spawned,
		]).toEqual([]);
	});

	test('without arguments, a note of pap’s own', async () => {
		const fake = fakeIo({env: ENV, executables: ['/usr/bin/gh']});

		expect(await run(['gh'], fake.io, 'x')).toBe(0);
		expect(fake.output.out).toContain('plain gh is signed out');
		expect(fake.output.out).toContain('pap --connection <id> gh <args>');
		expect(fake.spawned).toEqual([]);
	});
});
