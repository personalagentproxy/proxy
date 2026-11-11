import {describe, expect, test} from 'bun:test';

import {fakeIo} from './fake-io';
import {run} from './run';

// `pap files` as a sandbox command runs it, against a drive made of `answer`: what each request
// asked, with which body, and what pap wrote, on the screen and on its disk.
type Asked = {
	method: string;
	path: string;
	authorization: string | null;
	type: string | null;
	body: string | null;
};

const NOTES = '/home/user/.pap/files.json';

function harness(
	answer: (asked: Asked) => Response,
	disk: Record<string, string> = {},
	directories: string[] = [],
) {
	const asked: Asked[] = [];
	const fake = fakeIo({
		env: {PAP_URL: 'https://app.example.com', PAP_TOKEN: 'pap_token', HOME: '/home/user'},
		disk,
		directories,
		fetch: async (url, init) => {
			const headers = new Headers(init.headers);
			const body = init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : null;
			const one = {
				method: init.method ?? 'GET',
				path: url.replace('https://app.example.com', ''),
				authorization: headers.get('authorization'),
				type: headers.get('content-type'),
				body,
			};
			asked.push(one);
			return answer(one);
		},
	});
	const text = (path: string) => {
		const bytes = fake.disk.get(path);
		return bytes === undefined ? null : new TextDecoder().decode(bytes);
	};
	return {
		asked,
		output: fake.output,
		text,
		notes: () => JSON.parse(text(NOTES) ?? '{}'),
		pap: (...args: string[]) => run(args, fake.io, 'abc123'),
	};
}

// A file's bytes, with which file they are in the header, as the api sends them.
function bytesOf(
	content: string,
	file: {id: string; version: string; name: string; path: string},
): Response {
	return new Response(content, {
		headers: {
			'x-pap-file': encodeURIComponent(
				JSON.stringify({...file, folder: false, size: content.length, type: 'text/csv'}),
			),
		},
	});
}

const q3 = {id: 'file-1', version: 'v1', name: 'q3.csv', path: 'Reports/q3.csv'};

describe('pap files', () => {
	test('ls lists a folder by its path, or the top, with the token, and prints the answer as JSON alone', async () => {
		const listed = {
			path: 'Reports',
			files: [
				{
					id: 'file-1',
					name: 'q3.csv',
					path: 'Reports/q3.csv',
					folder: false,
					version: 'v1',
					size: 26,
					type: 'text/csv',
				},
			],
		};
		const {asked, output, pap} = harness(() => Response.json(listed));

		expect(await pap('files', 'ls', 'drive-1', 'Reports')).toBe(0);
		expect(await pap('files', 'ls', 'drive-1')).toBe(0);

		expect(asked.map(({method, path, authorization}) => [method, path, authorization])).toEqual([
			['GET', '/api/cli/files/drive-1/list?path=Reports', 'Bearer pap_token'],
			['GET', '/api/cli/files/drive-1/list', 'Bearer pap_token'],
		]);
		expect(output.out.split('\n')[0]).toBe(JSON.stringify(listed));
		expect(output.err).toBe('');
	});

	test('pull writes a file’s bytes under its own name, to a path or into a directory, and notes where each is from', async () => {
		const {asked, output, text, notes, pap} = harness(() => bytesOf('date,amount\n', q3), {}, [
			'/work/data',
		]);

		expect(await pap('files', 'pull', 'drive-1', 'Reports/q3.csv')).toBe(0);
		expect(await pap('files', 'pull', 'drive-1', 'Reports/q3.csv', 'copy.csv')).toBe(0);
		expect(await pap('files', 'pull', 'drive-1', 'Reports/q3.csv', 'data')).toBe(0);

		expect(asked.map((one) => one.path)).toEqual(
			Array.from({length: 3}, () => '/api/cli/files/drive-1/content?path=Reports%2Fq3.csv'),
		);
		expect([text('/work/q3.csv'), text('/work/copy.csv'), text('/work/data/q3.csv')]).toEqual([
			'date,amount\n',
			'date,amount\n',
			'date,amount\n',
		]);
		expect(JSON.parse(output.out.split('\n')[0] ?? '')).toEqual({
			file: '/work/q3.csv',
			size: 12,
			id: 'file-1',
			version: 'v1',
			path: 'Reports/q3.csv',
		});
		const from = {connection: 'drive-1', id: 'file-1', version: 'v1', path: 'Reports/q3.csv'};
		expect(notes()).toEqual({
			'/work/q3.csv': from,
			'/work/copy.csv': from,
			'/work/data/q3.csv': from,
		});
	});

	test('pull takes a file by its id and an earlier version of it, as a file attached to the conversation is named', async () => {
		const {asked, pap} = harness(() => bytesOf('old', {...q3, version: 'v0'}));

		expect(
			await pap('files', 'pull', 'drive-1', '--id', 'file-1', '--version', 'v0', 'old.csv'),
		).toBe(0);

		expect(asked[0]?.path).toBe('/api/cli/files/drive-1/content?id=file-1&version=v0');
	});

	test('push sends a pulled file back where it came from, naming the version it held, and notes the one it holds now', async () => {
		const pushed = {
			file: {...q3, version: 'v2', folder: false, size: 5, type: 'text/csv'},
			created: false,
			link: 'https://app.example.com/acme/connections/drive-1?file=file-1',
		};
		const {asked, output, notes, pap} = harness(() => Response.json(pushed), {
			'/work/q3.csv': 'a,b\n1',
			[NOTES]: JSON.stringify({
				'/work/q3.csv': {
					connection: 'drive-1',
					id: 'file-1',
					version: 'v1',
					path: 'Reports/q3.csv',
				},
			}),
		});

		expect(await pap('files', 'push', 'q3.csv')).toBe(0);

		expect(asked).toEqual([
			{
				method: 'PUT',
				path: '/api/cli/files/drive-1/content?path=Reports%2Fq3.csv&version=v1',
				authorization: 'Bearer pap_token',
				type: 'application/octet-stream',
				body: 'a,b\n1',
			},
		]);
		expect(JSON.parse(output.out)).toEqual({
			file: '/work/q3.csv',
			id: 'file-1',
			version: 'v2',
			path: 'Reports/q3.csv',
			created: false,
			link: pushed.link,
		});
		// The next push of it names the version this one made.
		expect(notes()['/work/q3.csv']).toEqual({
			connection: 'drive-1',
			id: 'file-1',
			version: 'v2',
			path: 'Reports/q3.csv',
		});
	});

	test('push sends a new file to the path said, under its own name where the path is a folder’s, with no version to name; --force writes over what is there', async () => {
		const made = {
			file: {
				id: 'file-9',
				name: 'chart.png',
				path: 'Reports/chart.png',
				folder: false,
				version: 'v1',
				size: 3,
				type: 'image/png',
			},
			created: true,
			link: 'https://app.example.com/x',
		};
		const {asked, pap} = harness(() => Response.json(made), {'/work/out/chart.png': 'png'});

		expect(await pap('files', 'push', 'out/chart.png', 'drive-1', 'Reports/')).toBe(0);
		expect(
			await pap('files', 'push', 'out/chart.png', 'drive-1', 'Other/final.png', '--force'),
		).toBe(0);

		expect(asked.map((one) => one.path)).toEqual([
			'/api/cli/files/drive-1/content?path=Reports%2Fchart.png',
			'/api/cli/files/drive-1/content?path=Other%2Ffinal.png&force=1',
		]);
	});

	test('says what the drive refused in its own words and exits as a failed call; a refused token exits as one', async () => {
		const stale = harness(
			() =>
				Response.json(
					{
						error: 'conflict',
						message: 'Reports/q3.csv changed since it was pulled: it holds version v3 now.',
					},
					{status: 422},
				),
			{'/work/q3.csv': 'x'},
		);
		expect(await stale.pap('files', 'push', 'q3.csv', 'drive-1', 'Reports/q3.csv')).toBe(1);
		expect(stale.output).toEqual({
			out: '',
			err: 'pap: Reports/q3.csv changed since it was pulled: it holds version v3 now.\n',
		});

		const expired = harness(() =>
			Response.json({error: 'unauthenticated', message: 'PAP_TOKEN has expired.'}, {status: 401}),
		);
		expect(await expired.pap('files', 'ls', 'drive-1')).toBe(3);
		expect(expired.output.err).toBe('pap: PAP_TOKEN has expired.\n');
	});

	test('a file that was never pulled has to be told where it goes, and a missing one is said', async () => {
		const {asked, output, pap} = harness(() => Response.json({}), {'/work/new.txt': 'x'});

		expect(await pap('files', 'push', 'new.txt')).toBe(2);
		expect(output.err).toContain(
			'new.txt was not pulled with pap files pull, so say where it goes',
		);
		expect(await pap('files', 'push', 'gone.txt', 'drive-1', 'gone.txt')).toBe(1);
		expect(output.err).toContain('Could not read gone.txt');
		expect(asked).toEqual([]);
	});

	test('without a command, or with --help, says what there is; one it hasn’t is a usage error', async () => {
		const {output, pap} = harness(() => Response.json({}));

		expect(await pap('files')).toBe(0);
		expect(output.out).toContain(
			'pap files pull <connection> <path> [to] [--id <file>] [--version <version>]',
		);
		expect(await pap('files', 'rm', 'x')).toBe(2);
		expect(output.err).toBe('pap: no command files rm. See pap files --help.\n');
		expect(await pap('files', 'pull', 'drive-1')).toBe(2);
	});
});
