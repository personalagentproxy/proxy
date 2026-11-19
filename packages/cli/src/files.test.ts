import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';

import {fakeIo} from './fake-io';
import {run} from './run';

// `pap files` as a sandbox command runs it, against a drive made of `answer`: what each request
// asked, with which body, and what pap wrote, on the screen and on its disk.
type Asked = {
	method: string;
	path: string;
	authorization: string | null;
	type: string | null;
	length: string | null;
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
			const body =
				init.body === undefined || init.body === null ? null : await new Response(init.body).text();
			const one = {
				method: init.method ?? 'GET',
				path: url.replace('https://app.example.com', ''),
				authorization: headers.get('authorization'),
				type: headers.get('content-type'),
				length: headers.get('content-length'),
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

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

// A drive that takes a push: the start answered with PAP's own URL for the bytes, the bytes taken
// there as `bytes` answers them, and done answered with `done`.
function drive(answers: {done?: Record<string, unknown>; bytes?: () => Response}) {
	return (asked: Asked): Response => {
		if (asked.method === 'POST' && asked.path.includes('/uploads?')) {
			return Response.json({
				upload: 'upload-1',
				put: {
					url: 'https://app.example.com/api/uploads/secret-1',
					method: 'PUT',
					headers: {},
					expiresAt: '2026-11-18T13:00:00.000Z',
					resumable: false,
				},
			});
		}
		if (asked.method === 'PUT') {
			return (
				answers.bytes?.() ?? Response.json({upload: 'upload-1', size: 0, sha256: '', next: ''})
			);
		}
		return Response.json(answers.done ?? {});
	};
}

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

	test('pull takes a file by its id and an earlier version of it, as a file attached in a thread is named', async () => {
		const {asked, pap} = harness(() => bytesOf('old', {...q3, version: 'v0'}));

		expect(
			await pap('files', 'pull', 'drive-1', '--id', 'file-1', '--version', 'v0', 'old.csv'),
		).toBe(0);

		expect(asked[0]?.path).toBe('/api/cli/files/drive-1/content?id=file-1&version=v0');
	});

	test('push starts an upload of a pulled file back where it came from, naming the version it held, sends its bytes to the URL without the token, and notes the version done made', async () => {
		const pushed = {
			file: {...q3, version: 'v2', folder: false, size: 5, type: 'text/csv'},
			created: false,
			link: 'https://app.example.com/acme/connections/drive-1?file=file-1',
		};
		const {asked, output, notes, pap} = harness(drive({done: pushed}), {
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
				method: 'POST',
				path: `/api/cli/files/drive-1/uploads?path=Reports%2Fq3.csv&size=5&sha256=${sha256('a,b\n1')}&file=q3.csv&version=v1`,
				authorization: 'Bearer pap_token',
				type: null,
				length: null,
				body: null,
			},
			{
				method: 'PUT',
				path: '/api/uploads/secret-1',
				authorization: null,
				type: null,
				length: '5',
				body: 'a,b\n1',
			},
			{
				method: 'POST',
				path: '/api/cli/files/drive-1/uploads/upload-1/done',
				authorization: 'Bearer pap_token',
				type: null,
				length: null,
				body: null,
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

	test('push starts a new file at the path said, under its own name where the path is a folder’s, with no version to name; --force writes over what is there', async () => {
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
		const {asked, pap} = harness(drive({done: made}), {'/work/out/chart.png': 'png'});

		expect(await pap('files', 'push', 'out/chart.png', 'drive-1', 'Reports/')).toBe(0);
		expect(
			await pap('files', 'push', 'out/chart.png', 'drive-1', 'Other/final.png', '--force'),
		).toBe(0);

		const hash = sha256('png');
		expect(asked.filter((one) => one.path.includes('/uploads?')).map((one) => one.path)).toEqual([
			`/api/cli/files/drive-1/uploads?path=Reports%2Fchart.png&size=3&sha256=${hash}&file=chart.png`,
			`/api/cli/files/drive-1/uploads?path=Other%2Ffinal.png&size=3&sha256=${hash}&file=chart.png&force=1`,
		]);
	});

	test('says what the drive refused in its own words and exits as a failed call, sending nothing; a refused token exits as one', async () => {
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
		expect(stale.asked.map((one) => one.method)).toEqual(['POST']);

		const expired = harness(() =>
			Response.json({error: 'unauthenticated', message: 'PAP_TOKEN has expired.'}, {status: 401}),
		);
		expect(await expired.pap('files', 'ls', 'drive-1')).toBe(3);
		expect(expired.output.err).toBe('pap: PAP_TOKEN has expired.\n');
	});

	test('says what the upload’s URL refused, and makes nothing of it', async () => {
		const tooLarge = {
			error: 'too_large',
			message: 'More than the 1 bytes upload upload-1 was started for came.',
		};
		const {asked, output, notes, pap} = harness(
			drive({bytes: () => Response.json(tooLarge, {status: 413})}),
			{'/work/q3.csv': 'grown'},
		);

		expect(await pap('files', 'push', 'q3.csv', 'drive-1', 'Reports/q3.csv')).toBe(1);

		expect(output.err).toBe(`pap: ${tooLarge.message}\n`);
		expect(asked.map((one) => one.method)).toEqual(['POST', 'PUT']);
		expect(notes()).toEqual({});
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

	test('pull asks for a Google Doc, Sheet or Slides file as an export, writes it under the name the export has, and notes what it was exported as', async () => {
		const plan = {
			id: 'doc-1',
			version: '42',
			name: 'Launch plan.docx',
			path: 'My Drive/Plans/Launch plan',
		};
		const {asked, output, text, notes, pap} = harness(
			() =>
				new Response('docx bytes', {
					headers: {
						'x-pap-file': encodeURIComponent(
							JSON.stringify({...plan, folder: false, size: null, type: 'docx', format: 'docx'}),
						),
					},
				}),
		);

		expect(
			await pap('files', 'pull', 'google-1', 'My Drive/Plans/Launch plan', '--as', 'docx'),
		).toBe(0);
		expect(
			await pap('files', 'pull', 'google-1', '--id', 'sheet-1', '--as', 'csv', '--tab', 'Q3'),
		).toBe(0);

		expect(asked.map((one) => one.path)).toEqual([
			'/api/cli/files/google-1/content?path=My+Drive%2FPlans%2FLaunch+plan&as=docx',
			'/api/cli/files/google-1/content?id=sheet-1&as=csv&tab=Q3',
		]);
		expect(text('/work/Launch plan.docx')).toBe('docx bytes');
		expect(JSON.parse(output.out.split('\n')[0] ?? '')).toMatchObject({
			file: '/work/Launch plan.docx',
			version: '42',
			format: 'docx',
		});
		expect(notes()['/work/Launch plan.docx']).toEqual({
			connection: 'google-1',
			id: 'doc-1',
			version: '42',
			path: 'My Drive/Plans/Launch plan',
			format: 'docx',
		});
	});

	test('pull and push take only the formats there are, as usage errors, asking nothing', async () => {
		const {asked, output, pap} = harness(() => Response.json({}), {'/work/a.txt': 'a'});

		expect(await pap('files', 'pull', 'google-1', 'My Drive/a', '--as', 'odt')).toBe(2);
		expect(output.err).toBe('pap: --as takes md, docx, pdf, xlsx, csv, pptx, txt, not odt.\n');
		expect(await pap('files', 'push', 'a.txt', 'google-1', 'My Drive/a', '--as', 'docx')).toBe(2);
		expect(output.err).toContain('pap: --as takes doc, sheet, slides, not docx.');
		expect(asked).toEqual([]);
	});

	test('push --as asks for a new file to be made a Doc, Sheet or Slides file, and --id writes over a file by its id, naming the version pulled of it', async () => {
		const made = {
			file: {
				id: 'doc-2',
				name: 'Notes',
				path: 'My Drive/Notes',
				folder: false,
				version: '1',
				size: null,
				type: 'application/vnd.google-apps.document',
			},
			created: true,
			link: 'https://docs.google.com/document/d/doc-2/edit',
		};
		const {asked, notes, pap} = harness(drive({done: made}), {
			'/work/notes.md': '# Notes',
			'/work/plan.docx': 'docx',
			[NOTES]: JSON.stringify({
				'/work/plan.docx': {
					connection: 'google-1',
					id: 'doc-1',
					version: '42',
					path: 'Shared with me/plan',
					format: 'docx',
				},
			}),
		});

		expect(await pap('files', 'push', 'notes.md', 'google-1', 'My Drive/', '--as', 'doc')).toBe(0);
		expect(await pap('files', 'push', 'plan.docx', '--id', 'doc-1')).toBe(0);
		expect(await pap('files', 'push', 'plan.docx', 'google-1', '--id', 'doc-9')).toBe(0);
		expect(await pap('files', 'push', 'plan.docx', 'google-1', 'My Drive/x', '--id', 'doc-1')).toBe(
			2,
		);

		expect(asked.filter((one) => one.path.includes('/uploads?')).map((one) => one.path)).toEqual([
			`/api/cli/files/google-1/uploads?path=My+Drive%2Fnotes.md&size=7&sha256=${sha256('# Notes')}&file=notes.md&as=doc`,
			`/api/cli/files/google-1/uploads?id=doc-1&size=4&sha256=${sha256('docx')}&file=plan.docx&version=42`,
			`/api/cli/files/google-1/uploads?id=doc-9&size=4&sha256=${sha256('docx')}&file=plan.docx`,
		]);
		expect(notes()['/work/notes.md']).toEqual({
			connection: 'google-1',
			id: 'doc-2',
			version: '1',
			path: 'My Drive/Notes',
		});
	});

	test('push --id needs a connection where the file was never pulled', async () => {
		const {asked, output, pap} = harness(() => Response.json({}), {'/work/new.pdf': 'x'});

		expect(await pap('files', 'push', 'new.pdf', '--id', 'file-1')).toBe(2);
		expect(output.err).toContain(
			'new.pdf was not pulled with pap files pull, so say which connection it goes to',
		);
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
