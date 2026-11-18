import {describe, expect, test} from 'bun:test';

import {fakeIo} from './fake-io';
import {PART_BYTES, type Put, sendFile} from './send-file';

// A file's bytes sent to an upload's URL, against a fake resumable session as Google Drive keeps
// one: it takes parts in order, each with its Content-Range, answers 308 with what it has, and 200
// once it has it all; asked with `bytes */<size>`, it says what it has. `fault` makes a part fail:
// cut off on the way, with half of it arrived, or answered with a server error.
type Fault = 'drop' | 503 | 404 | null;

const PATH = '/work/big.bin';

const SESSION: Put = {
	url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1',
	headers: {},
	resumable: true,
};

function bytesOf(size: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index += 1) {
		bytes[index] = index % 251;
	}
	return bytes;
}

function joined(one: Uint8Array, other: Uint8Array): Uint8Array {
	const both = new Uint8Array(one.byteLength + other.byteLength);
	both.set(one);
	both.set(other, one.byteLength);
	return both;
}

function session(file: Uint8Array<ArrayBuffer>, fault: (call: number) => Fault = () => null) {
	const size = file.byteLength;
	let have: Uint8Array = new Uint8Array(0);
	const calls: Array<{range: string | null; length: number; authorization: string | null}> = [];
	// The file, once it has all of it; otherwise 308, with what it has where it has any.
	const answer = () => {
		if (have.byteLength === size) {
			return Response.json({id: 'drive-file-1'});
		}
		if (have.byteLength === 0) {
			return new Response(null, {status: 308});
		}
		return new Response(null, {status: 308, headers: {range: `bytes=0-${have.byteLength - 1}`}});
	};
	const fake = fakeIo({
		disk: {[PATH]: file},
		fetch: async (_url, init) => {
			const headers = new Headers(init.headers);
			const range = headers.get('content-range');
			const body = new Uint8Array(await new Response(init.body).arrayBuffer());
			calls.push({range, length: body.byteLength, authorization: headers.get('authorization')});
			if (range === `bytes */${size}`) {
				return answer();
			}
			const [, first = '', last = ''] = /^bytes (\d+)-(\d+)\/\d+$/.exec(range ?? '') ?? [];
			if (
				Number(first) !== have.byteLength ||
				Number(last) - Number(first) + 1 !== body.byteLength
			) {
				return new Response(null, {status: 400});
			}
			const failing = fault(calls.length);
			if (failing === 'drop') {
				have = joined(have, body.subarray(0, body.byteLength / 2));
				throw new TypeError('fetch failed');
			}
			if (failing === 503) {
				return new Response(null, {status: 503});
			}
			if (failing === 404) {
				return Response.json(
					{error: {code: 404, message: 'The upload session was not found.'}},
					{status: 404},
				);
			}
			have = joined(have, body);
			return answer();
		},
	});
	return {
		calls,
		slept: fake.slept,
		have: () => have,
		send: () => sendFile(fake.io, PATH, size, SESSION),
	};
}

describe('sending a file to an upload’s URL', () => {
	const size = 2 * PART_BYTES + 1000;
	const file = bytesOf(size);

	test('sends a resumable upload in parts of 8 MiB, each with its Content-Range, and no token', async () => {
		const drive = session(file);

		expect((await drive.send()).isOk()).toBe(true);

		expect(drive.calls).toEqual([
			{range: `bytes 0-${PART_BYTES - 1}/${size}`, length: PART_BYTES, authorization: null},
			{
				range: `bytes ${PART_BYTES}-${2 * PART_BYTES - 1}/${size}`,
				length: PART_BYTES,
				authorization: null,
			},
			{range: `bytes ${2 * PART_BYTES}-${size - 1}/${size}`, length: 1000, authorization: null},
		]);
		expect(drive.have()).toEqual(file);
		expect(PART_BYTES % (256 * 1024)).toBe(0);
	});

	test('after a part is cut off, waits, asks what arrived and sends the rest from there', async () => {
		const drive = session(file, (call) => (call === 2 ? 'drop' : null));

		expect((await drive.send()).isOk()).toBe(true);

		const half = PART_BYTES + PART_BYTES / 2;
		expect(drive.calls.map((call) => call.range)).toEqual([
			`bytes 0-${PART_BYTES - 1}/${size}`,
			`bytes ${PART_BYTES}-${2 * PART_BYTES - 1}/${size}`,
			`bytes */${size}`,
			`bytes ${half}-${size - 1}/${size}`,
		]);
		expect(drive.slept).toEqual([1000]);
		expect(drive.have()).toEqual(file);
	});

	test('after a server error, asks what arrived, from nothing, and sends it again', async () => {
		const drive = session(file, (call) => (call === 1 ? 503 : null));

		expect((await drive.send()).isOk()).toBe(true);

		expect(drive.calls.map((call) => call.range).slice(0, 3)).toEqual([
			`bytes 0-${PART_BYTES - 1}/${size}`,
			`bytes */${size}`,
			`bytes 0-${PART_BYTES - 1}/${size}`,
		]);
		expect(drive.have()).toEqual(file);
	});

	test('says a refusal in the server’s words, without trying again', async () => {
		const drive = session(file, () => 404);

		const sent = await drive.send();

		expect(sent.isErr() && sent.error.message).toBe('The upload session was not found.');
		expect(drive.calls.length).toBe(1);
		expect(drive.slept).toEqual([]);
	});

	test('gives up after failing again and again, waiting longer each time', async () => {
		const drive = session(file, () => 503);

		const sent = await drive.send();

		expect(sent.isErr() && sent.error.message).toBe(
			`Could not send ${PATH}: the upload’s URL answered 503. Push it again.`,
		);
		expect(drive.slept).toEqual([1000, 2000, 4000, 8000, 16000]);
	});

	test('ends an empty file’s upload with nothing sent', async () => {
		const drive = session(new Uint8Array(0));

		expect((await drive.send()).isOk()).toBe(true);
		expect(drive.calls).toEqual([{range: 'bytes */0', length: 0, authorization: null}]);
	});

	test('sends a file to Personal Agent Proxy’s own URL in one PUT, streamed, with its length', async () => {
		const asked: Array<{length: string | null; body: number}> = [];
		const fake = fakeIo({
			disk: {[PATH]: file},
			fetch: async (_url, init) => {
				asked.push({
					length: new Headers(init.headers).get('content-length'),
					body: (await new Response(init.body).arrayBuffer()).byteLength,
				});
				return Response.json({upload: 'upload-1', size, sha256: '', next: ''});
			},
		});

		const sent = await sendFile(fake.io, PATH, size, {
			url: 'https://app.example.com/api/uploads/secret-1',
			headers: {},
			resumable: false,
		});

		expect(sent.isOk()).toBe(true);
		expect(asked).toEqual([{length: String(size), body: size}]);
		expect(fake.read).toEqual([{path: PATH}]);
	});
});
