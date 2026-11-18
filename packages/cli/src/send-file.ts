import {Err, Ok, Result} from 'ts-results-es';

import {type Failure, failed, type Io, isObject, type Json} from './io';

/**
 * A file's bytes sent to the URL an upload was answered with (`pap files push`, files.ts), read
 * from disk as they go, never whole. The URL is its own credential, so PAP_TOKEN is never sent to
 * it. At Personal Agent Proxy's own URL, the file goes in one PUT. At one that is `resumable`, as a
 * Google Drive upload session is, it goes in parts of 8 MiB, each with its `Content-Range`, answered
 * 308 with how much has arrived (`Range: bytes=0-<last>`) until the last is answered 200 or 201;
 * where a part is cut off on the way or the server fails on it (5xx), pap waits, asks how much
 * arrived (`Content-Range: bytes * /<size>`, sent with nothing) and sends the rest from there.
 */

/** Where the bytes go and how, as the upload was answered with it. */
export type Put = {url: string; headers: Record<string, string>; resumable: boolean};

/** A part of a resumable upload: a multiple of 256 KiB, as Google Drive takes them, but the last. */
export const PART_BYTES = 8 * 1024 * 1024;

// How many tries in a row may come to nothing more arrived before pap gives up, and the longest it
// waits between two.
const MAX_FAILURES = 5;
const MAX_WAIT_MS = 16_000;

// What a PUT came to: an answer, or a failure on the way, with why.
type Sent = Result<Response, Error>;

function errorText(cause: Error | string | null): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// The words a refusal came with: PAP's `message`, or Google's `error.message`.
async function refusalOf(response: Response): Promise<string> {
	const text = (await Result.wrapAsync<string, Error>(() => response.text())).unwrapOr('');
	const body = Result.wrap((): Json => JSON.parse(text)).unwrapOr(null);
	if (isObject(body) && typeof body.message === 'string') {
		return body.message;
	}
	if (isObject(body) && isObject(body.error) && typeof body.error.message === 'string') {
		return body.error.message;
	}
	return `The upload’s URL answered ${response.status}.`;
}

function put(io: Io, url: string, init: RequestInit & {duplex?: 'half'}): Promise<Sent> {
	return Result.wrapAsync<Response, Error>(() => io.fetch(url, {...init, method: 'PUT'}));
}

// The whole file in one PUT, streamed from disk with its length said first.
async function sendWhole(
	io: Io,
	path: string,
	size: number,
	to: Put,
): Promise<Result<void, Failure>> {
	const sent = await put(io, to.url, {
		headers: {...to.headers, 'content-length': String(size)},
		body: io.readStream(path),
		duplex: 'half',
	});
	if (sent.isErr()) {
		return Err(failed(`Could not send ${path}: ${errorText(sent.error)}. Push it again.`));
	}
	if (!sent.value.ok) {
		return Err(failed(await refusalOf(sent.value)));
	}
	await sent.value.body?.cancel();
	return Ok(undefined);
}

// The part from `start`, up to `PART_BYTES` of it, read into memory so its length is known; from
// the end, nothing, which asks how much arrived, and ends an upload of an empty file.
async function sendPart(io: Io, path: string, size: number, start: number, to: Put): Promise<Sent> {
	const end = Math.min(start + PART_BYTES, size);
	if (end <= start) {
		return put(io, to.url, {
			headers: {...to.headers, 'content-range': `bytes */${size}`},
			body: new Uint8Array(),
		});
	}
	const part = await Result.wrapAsync<ArrayBuffer, Error>(() =>
		new Response(io.readStream(path, {start, end})).arrayBuffer(),
	);
	if (part.isErr()) {
		return part;
	}
	return put(io, to.url, {
		headers: {...to.headers, 'content-range': `bytes ${start}-${end - 1}/${size}`},
		body: new Uint8Array(part.value),
	});
}

// Asks how much of the file arrived, sending nothing.
function askArrived(io: Io, size: number, to: Put): Promise<Sent> {
	return put(io, to.url, {
		headers: {...to.headers, 'content-range': `bytes */${size}`},
		body: new Uint8Array(),
	});
}

// How many bytes a 308 says arrived: none without a `Range`; null for one that can't be read.
function arrivedOf(response: Response): number | null {
	const range = response.headers.get('range');
	if (range === null) {
		return 0;
	}
	const last = /^bytes=0-(\d+)$/.exec(range.trim())?.[1];
	return last === undefined ? null : Number(last) + 1;
}

// The file in parts, from where the server says it has it up to, until it says it has it all.
async function sendResumable(
	io: Io,
	path: string,
	size: number,
	to: Put,
): Promise<Result<void, Failure>> {
	// How much arrived, as the server last said; null where it has to be asked, after a failure.
	let from: number | null = 0;
	let most = 0;
	let failures = 0;
	const gaveUp = (why: string) => Err(failed(`Could not send ${path}: ${why}. Push it again.`));
	for (;;) {
		const sent =
			from === null ? await askArrived(io, size, to) : await sendPart(io, path, size, from, to);
		if (sent.isErr() || sent.value.status >= 500) {
			const why = sent.isErr()
				? errorText(sent.error)
				: `the upload’s URL answered ${sent.value.status}`;
			if (sent.isOk()) {
				await sent.value.body?.cancel();
			}
			failures += 1;
			if (failures > MAX_FAILURES) {
				return gaveUp(why);
			}
			await io.sleep(Math.min(1000 * 2 ** (failures - 1), MAX_WAIT_MS));
			from = null;
			continue;
		}
		const response = sent.value;
		if (response.status === 200 || response.status === 201) {
			await response.body?.cancel();
			return Ok(undefined);
		}
		if (response.status !== 308) {
			return Err(failed(await refusalOf(response)));
		}
		await response.body?.cancel();
		const arrived = arrivedOf(response);
		if (arrived === null || arrived > size) {
			return Err(
				failed(
					`The upload’s URL said it has ${response.headers.get('range')} of ${size} bytes. Push it again.`,
				),
			);
		}
		// Nothing more arrived of what was sent: a try that came to nothing, as one that failed.
		if (arrived <= most && from !== null) {
			failures += 1;
			if (failures > MAX_FAILURES) {
				return gaveUp('nothing more arrived');
			}
		}
		if (arrived > most) {
			failures = 0;
			most = arrived;
		}
		from = arrived;
	}
}

/** Sends the file at `path`, `size` bytes, to where the upload said, as one PUT or in parts. */
export function sendFile(
	io: Io,
	path: string,
	size: number,
	to: Put,
): Promise<Result<void, Failure>> {
	return to.resumable ? sendResumable(io, path, size, to) : sendWhole(io, path, size, to);
}
