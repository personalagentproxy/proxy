import {describe, expect, test} from 'bun:test';

import type {Io, Json} from './io';
import {MAX_PAGES} from './pages';
import {run} from './run';

// pap as a sandbox command runs it, against a server made of `answer`: what each request sent,
// and what pap wrote and exited with.
type Sent = {url: string; authorization: string | null; body: Json};

function harness(
	answer: (body: {method: string; args: Json[]}) => Response | Promise<Response>,
	options: {env?: Record<string, string | undefined>; stdin?: string} = {},
) {
	const sent: Sent[] = [];
	const output = {out: '', err: ''};
	const io: Io = {
		env: options.env ?? {PAP_URL: 'https://app.example.com/', PAP_TOKEN: 'pap_token'},
		readStdin: async () => options.stdin ?? '',
		out: (text) => {
			output.out += text;
		},
		err: (text) => {
			output.err += text;
		},
		fetch: async (url, init) => {
			const body = JSON.parse(String(init.body)) as {method: string; args: Json[]};
			sent.push({url, authorization: new Headers(init.headers).get('authorization'), body});
			return answer(body);
		},
	};
	return {sent, output, pap: (...args: string[]) => run(args, io, 'abc123')};
}

const ok = (result: Json) => Response.json({result});

describe('pap', () => {
	test('connections asks for them with the token, and prints the result as JSON alone', async () => {
		const {sent, output, pap} = harness(() => ok([{connection: 'mail-1', integration: 'Email'}]));

		expect(await pap('connections')).toBe(0);
		expect(sent).toEqual([
			{
				url: 'https://app.example.com/api/cli/call',
				authorization: 'Bearer pap_token',
				body: {method: 'connections', args: []},
			},
		]);
		expect(output).toEqual({out: '[{"connection":"mail-1","integration":"Email"}]\n', err: ''});
	});

	test('tools, call and feedback send their arguments as a script passes them', async () => {
		const {sent, pap} = harness(() => ok(null));

		await pap('tools', 'mail-1');
		await pap('call', 'mail-1', 'emails_list', '{"search":"invoice"}');
		await pap('call', 'mail-1', 'emails_list');
		await pap(
			'feedback',
			'No',
			'way',
			'to',
			'archive',
			'--connection',
			'mail-1',
			'--tool=emails_list',
		);
		await pap('feedback', 'Missing');

		expect(sent.map((one) => one.body)).toEqual([
			{method: 'tools', args: ['mail-1']},
			{method: 'call', args: ['mail-1', 'emails_list', {search: 'invoice'}]},
			{method: 'call', args: ['mail-1', 'emails_list', {}]},
			{
				method: 'feedback',
				args: [{message: 'No way to archive', connection: 'mail-1', tool: 'emails_list'}],
			},
			{method: 'feedback', args: [{message: 'Missing'}]},
		]);
	});

	test('- reads the params from stdin', async () => {
		const {sent, pap} = harness(() => ok({}), {stdin: '{"search": "from stdin"}\n'});

		expect(await pap('call', 'mail-1', 'emails_list', '-')).toBe(0);
		expect(sent[0]?.body).toEqual({
			method: 'call',
			args: ['mail-1', 'emails_list', {search: 'from stdin'}],
		});
	});

	test('a failed call exits 1 with the server’s words on stderr, nothing on stdout', async () => {
		const {output, pap} = harness(() =>
			Response.json(
				{error: 'forbidden', message: 'emails_send on mail-1: Not allowed.'},
				{status: 422},
			),
		);

		expect(await pap('call', 'mail-1', 'emails_send', '{}')).toBe(1);
		expect(output).toEqual({out: '', err: 'pap: emails_send on mail-1: Not allowed.\n'});
	});

	test('a refused token exits 3 with the server’s words', async () => {
		const {output, pap} = harness(() =>
			Response.json({error: 'unauthenticated', message: 'PAP_TOKEN has expired.'}, {status: 401}),
		);

		expect(await pap('connections')).toBe(3);
		expect(output).toEqual({out: '', err: 'pap: PAP_TOKEN has expired.\n'});
	});

	test('without PAP_URL or PAP_TOKEN, exits 3 saying to run it with pap: true, sending nothing', async () => {
		const {sent, output, pap} = harness(() => ok(null), {
			env: {PAP_URL: 'https://app.example.com'},
		});

		expect(await pap('connections')).toBe(3);
		expect(output.err).toBe(
			'pap: PAP_URL and PAP_TOKEN are not set: run pap in a sandbox_exec command with pap: true.\n',
		);
		expect(output.out).toBe('');
		expect(sent).toEqual([]);
	});

	test('the server failing, or out of reach, exits 1', async () => {
		const down = harness(() => Promise.reject(new TypeError('fetch failed')));
		const broken = harness(() => new Response('Internal Server Error', {status: 500}));

		expect(await down.pap('connections')).toBe(1);
		expect(down.output).toEqual({
			out: '',
			err: 'pap: Could not reach PAP at https://app.example.com: fetch failed. Try again.\n',
		});
		expect(await broken.pap('connections')).toBe(1);
		expect(broken.output.err).toBe('pap: PAP answered 500. Try again.\n');
	});

	test('params that are not a JSON object, or arguments that aren’t right, exit 2 and send nothing', async () => {
		const {sent, output, pap} = harness(() => ok(null), {stdin: '[1]'});

		expect(await pap('call', 'mail-1', 'emails_list', '{search')).toBe(2);
		expect(await pap('call', 'mail-1', 'emails_list', '"text"')).toBe(2);
		expect(await pap('call', 'mail-1', 'emails_list', '-')).toBe(2);
		expect(await pap('call', 'mail-1')).toBe(2);
		expect(await pap('tools')).toBe(2);
		expect(await pap('connections', '--everything')).toBe(2);
		expect(await pap('feedback', '--tool')).toBe(2);
		expect(await pap('delete')).toBe(2);
		expect(sent).toEqual([]);
		expect(output.out).toBe('');
		const lines = output.err.trimEnd().split('\n');
		expect(lines).toHaveLength(8);
		expect(lines[0]).toBe(`pap: Params must be a JSON object, such as '{"search":"invoice"}'.`);
		expect(lines[2]).toBe(
			`pap: Params must be a JSON object, such as '{"search":"invoice"}' on stdin.`,
		);
		expect(lines[3]).toBe('pap: Usage: pap call <connection> <tool> [json|-] [--all]');
		expect(lines[5]).toBe('pap: pap connections has no --everything. See pap connections --help.');
		expect(lines[7]).toBe('pap: no command delete. See pap --help.');
	});

	test('--help, a command’s --help and --version need no token', async () => {
		const {sent, output, pap} = harness(() => ok(null), {env: {}});

		expect(await pap('--help')).toBe(0);
		expect(output.out).toContain('pap call <connection> <tool> [json|-] [--all]');
		expect(output.out).toContain(
			'Exit: 0 done, 1 call failed, 2 bad usage, 3 no token or token refused.',
		);
		output.out = '';
		expect(await pap('call', '--help')).toBe(0);
		expect(output.out).toContain('--all');
		output.out = '';
		expect(await pap('--version')).toBe(0);
		expect(output.out).toBe('abc123\n');
		expect(sent).toEqual([]);
	});
});

describe('pap call --all', () => {
	// A list of `pages` pages of two records each, its pages named by their number.
	function pagedList(pages: number) {
		return (body: {args: Json[]}) => {
			const params = body.args[2] as {page?: string};
			const at = Number(params.page ?? '1');
			return ok({
				records: [{id: `r${at}a`}, {id: `r${at}b`}],
				nextPage: at < pages ? String(at + 1) : null,
				trail: [{id: 'folder', title: 'Folder'}],
			});
		};
	}

	test('follows nextPage, passing it back as page, and prints the records as one list', async () => {
		const {sent, output, pap} = harness(pagedList(3));

		expect(await pap('call', 'vault-1', 'entries_list', '{"search":"x"}', '--all')).toBe(0);
		expect(sent.map((one) => one.body)).toEqual([
			{method: 'call', args: ['vault-1', 'entries_list', {search: 'x'}]},
			{method: 'call', args: ['vault-1', 'entries_list', {search: 'x', page: '2'}]},
			{method: 'call', args: ['vault-1', 'entries_list', {search: 'x', page: '3'}]},
		]);
		expect(JSON.parse(output.out)).toEqual({
			records: [{id: 'r1a'}, {id: 'r1b'}, {id: 'r2a'}, {id: 'r2b'}, {id: 'r3a'}, {id: 'r3b'}],
			nextPage: null,
			trail: [{id: 'folder', title: 'Folder'}],
		});
		expect(output.err).toBe('');
	});

	test(`stops after ${MAX_PAGES} pages, leaving nextPage to go on from and saying so on stderr`, async () => {
		const {sent, output, pap} = harness(pagedList(50));

		expect(await pap('call', 'vault-1', 'entries_list', '--all')).toBe(0);
		expect(sent).toHaveLength(MAX_PAGES);
		const result = JSON.parse(output.out) as {records: Json[]; nextPage: string};
		expect(result.records).toHaveLength(MAX_PAGES * 2);
		expect(result.nextPage).toBe(String(MAX_PAGES + 1));
		expect(output.err).toBe(
			`pap: stopped after ${MAX_PAGES} pages; for more, call again with "page": "${MAX_PAGES + 1}".\n`,
		);
	});

	test('an answer that is not a list page is printed as it is', async () => {
		const {sent, output, pap} = harness(() => ok({content: 'done'}));

		expect(await pap('call', 'custom-1', 'search', '--all')).toBe(0);
		expect(sent).toHaveLength(1);
		expect(output.out).toBe('{"content":"done"}\n');
	});

	test('a later page failing fails the whole call', async () => {
		let calls = 0;
		const {output, pap} = harness(() => {
			calls++;
			return calls === 1
				? ok({records: [], nextPage: '2'})
				: Response.json(
						{error: 'provider_unreachable', message: 'Gmail could not be reached; try again.'},
						{status: 422},
					);
		});

		expect(await pap('call', 'mail-1', 'emails_list', '--all')).toBe(1);
		expect(output).toEqual({out: '', err: 'pap: Gmail could not be reached; try again.\n'});
	});
});
