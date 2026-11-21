import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';

import {fakeIo} from './fake-io';
import {run} from './run';

// `pap upload` and `pap download` as a sandbox command runs them: the URL asked of PAP with the
// token, and the bytes sent to it, or fetched from it, without the token, streamed from and to disk.

const PUT_URL = 'https://app.example.com/api/blobs/blob_put';
const GET_URL = 'https://app.example.com/api/blobs/blob_get';

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

type Asked = {
	method: string;
	url: string;
	authorization: string | null;
	length: string | null;
	body: string | null;
};

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
				url,
				authorization: headers.get('authorization'),
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
		read: fake.read,
		pap: (...args: string[]) => run(args, fake.io, 'abc123'),
	};
}

describe('pap upload', () => {
	const content = '%PDF results';

	test('sends the file in one PUT to the URL upload gave, streamed, with its length and name and no token, and prints the blob', async () => {
		const {asked, output, read, pap} = harness(
			(one) => {
				if (one.url.endsWith('/api/cli/call')) {
					return Response.json({
						result: {url: PUT_URL, method: 'PUT', expiresAt: '2026-11-20T13:00:00.000Z'},
					});
				}
				return Response.json({
					blob: 'blob-1',
					name: 'report.pdf',
					size: content.length,
					sha256: sha256(content),
				});
			},
			{'/work/out/report.pdf': content},
		);

		expect(await pap('upload', 'out/report.pdf')).toBe(0);

		expect(asked.map((one) => [one.method, one.url, one.authorization])).toEqual([
			['POST', 'https://app.example.com/api/cli/call', 'Bearer pap_token'],
			['PUT', `${PUT_URL}?name=report.pdf`, null],
		]);
		expect(asked[0]?.body).toBe(JSON.stringify({method: 'upload', args: []}));
		expect([asked[1]?.length, asked[1]?.body]).toEqual([String(content.length), content]);
		expect(read).toEqual(['/work/out/report.pdf']);
		expect(JSON.parse(output.out)).toEqual({
			blob: 'blob-1',
			name: 'report.pdf',
			size: content.length,
			sha256: sha256(content),
		});
	});

	test('says what the URL refused it with, a send cut off on the way, and bytes that aren’t what was read', async () => {
		const answering = (put: () => Response) =>
			harness(
				(one) =>
					one.url.endsWith('/api/cli/call') ? Response.json({result: {url: PUT_URL}}) : put(),
				{'/work/report.pdf': content},
			);

		const refused = answering(() =>
			Response.json({error: 'too_large', message: 'A file is at most 1 MB.'}, {status: 413}),
		);
		expect(await refused.pap('upload', 'report.pdf')).toBe(1);
		expect(refused.output.err).toBe('pap: A file is at most 1 MB.\n');

		const cut = answering(() => {
			throw new Error('socket hang up');
		});
		expect(await cut.pap('upload', 'report.pdf')).toBe(1);
		expect(cut.output.err).toBe(
			'pap: Could not send /work/report.pdf: socket hang up. Send it again.\n',
		);

		const changed = answering(() =>
			Response.json({blob: 'blob-1', size: 3, sha256: sha256('new')}),
		);
		expect(await changed.pap('upload', 'report.pdf')).toBe(1);
		expect(changed.output.err).toBe(
			'pap: /work/report.pdf changed while it was sent: what arrived isn’t what was read. Send it again.\n',
		);
	});

	test('a missing file is said, asking nothing', async () => {
		const {asked, output, pap} = harness(() => Response.json({}));
		expect(await pap('upload', 'gone.pdf')).toBe(1);
		expect(output.err).toContain('Could not read /work/gone.pdf');
		expect(asked).toEqual([]);
		expect(await pap('upload')).toBe(2);
	});
});

describe('pap download', () => {
	const download = {
		blob: 'blob-1',
		name: 'Signed contract.pdf',
		type: 'application/pdf',
		size: 20,
		url: GET_URL,
		expiresAt: '2026-11-20T13:00:00.000Z',
	};

	function serving() {
		return (one: Asked) =>
			one.url.endsWith('/api/cli/call')
				? Response.json({result: download})
				: new Response('%PDF signed contract');
	}

	test('fetches a blob without the token, under its own name, to a path or into a directory', async () => {
		const {asked, output, text, pap} = harness(serving(), {}, ['/work/inbox']);

		expect(await pap('download', 'blob-1')).toBe(0);
		expect(JSON.parse(output.out)).toEqual({
			file: '/work/Signed contract.pdf',
			blob: 'blob-1',
			size: 20,
		});
		expect(text('/work/Signed contract.pdf')).toBe('%PDF signed contract');
		expect(asked.map((one) => [one.method, one.url, one.authorization])).toEqual([
			['POST', 'https://app.example.com/api/cli/call', 'Bearer pap_token'],
			['GET', GET_URL, null],
		]);
		expect(asked[0]?.body).toBe(JSON.stringify({method: 'download', args: ['blob-1']}));

		expect(await pap('download', 'blob-1', 'inbox')).toBe(0);
		expect(text('/work/inbox/Signed contract.pdf')).toBe('%PDF signed contract');
		expect(await pap('download', 'blob-1', 'contract.pdf')).toBe(0);
		expect(text('/work/contract.pdf')).toBe('%PDF signed contract');
	});

	test('says what PAP refused, and writes nothing', async () => {
		const {output, text, pap} = harness(() =>
			Response.json(
				{error: 'not_found', message: 'There is no blob blob-9 of yours.'},
				{status: 422},
			),
		);
		expect(await pap('download', 'blob-9')).toBe(1);
		expect(output.err).toBe('pap: There is no blob blob-9 of yours.\n');
		expect(text('/work/blob-9')).toBeNull();
		expect(await pap('download')).toBe(2);
	});
});
