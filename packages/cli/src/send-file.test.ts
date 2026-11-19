import {describe, expect, test} from 'bun:test';

import {fakeIo} from './fake-io';
import {sendFile} from './send-file';

// A file's bytes sent to an upload's URL, Personal Agent Proxy's own for every drive: one PUT,
// streamed from disk with its length, and no token.

const PATH = '/work/report.pdf';
const URL = 'https://app.example.com/api/uploads/secret-1';

describe('sendFile', () => {
	const file = new TextEncoder().encode('%PDF results');
	const size = file.byteLength;

	test('sends the file in one PUT, streamed, with its length and no token', async () => {
		const asked: Array<{
			method: string | undefined;
			length: string | null;
			authorization: string | null;
			body: number;
		}> = [];
		const fake = fakeIo({
			disk: {[PATH]: file},
			fetch: async (_url, init) => {
				const headers = new Headers(init.headers);
				asked.push({
					method: init.method,
					length: headers.get('content-length'),
					authorization: headers.get('authorization'),
					body: (await new Response(init.body).arrayBuffer()).byteLength,
				});
				return Response.json({upload: 'upload-1', size, sha256: '', next: ''});
			},
		});

		const sent = await sendFile(fake.io, PATH, size, {url: URL, headers: {}});

		expect(sent.isOk()).toBe(true);
		expect(asked).toEqual([{method: 'PUT', length: String(size), authorization: null, body: size}]);
		expect(fake.read).toEqual([PATH]);
	});

	test('says what the URL refused it with', async () => {
		const fake = fakeIo({
			disk: {[PATH]: file},
			fetch: async () =>
				Response.json(
					{error: 'expired', message: 'This URL took bytes for an hour, and the hour is up.'},
					{status: 410},
				),
		});

		const sent = await sendFile(fake.io, PATH, size, {url: URL, headers: {}});

		expect(sent.isErr() && sent.error.message).toBe(
			'This URL took bytes for an hour, and the hour is up.',
		);
	});

	test('a send cut off on the way is pushed again', async () => {
		const fake = fakeIo({
			disk: {[PATH]: file},
			fetch: async () => {
				throw new Error('socket hang up');
			},
		});

		const sent = await sendFile(fake.io, PATH, size, {url: URL, headers: {}});

		expect(sent.isErr() && sent.error.message).toBe(
			`Could not send ${PATH}: socket hang up. Push it again.`,
		);
	});
});
