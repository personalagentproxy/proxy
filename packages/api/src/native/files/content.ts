import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

import type {Request, Response} from 'express';
import {Err, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {completeFileBlob, createFileBlob, type FileBlobRow} from '@proxy/db/files';

import {blobBackend} from '../../backends/backends';
import {env} from '../../utils/env';

/**
 * The bytes of Files, in the server's blob store (backends/backends.ts): every content written
 * is a blob of its own, under a key nothing else has, never written again. A blob's row is made
 * first and completed once the store has every byte, with how many there were and their SHA-256,
 * counted here as they pass, so nothing is ever held whole in memory and nothing is in the store
 * that no row names; a blob whose upload fails is left to the sweep (sweeper.ts). Content past
 * the largest a file may be is refused as it comes, not after.
 */

/** The largest file taken, in bytes, as the server is set up. */
export function maxFileBytes(): number {
	return env.FILES_MAX_MB * 1024 * 1024;
}

function megabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** A blob stored, for a version to point at. */
export type StoredContent = {blobId: string; size: number; sha256: string};

/** A new blob's key in the store: under its organization, and nothing else's. */
export function newBlobKey(orgId: string): string {
	return `${orgId}/${randomBytes(16).toString('hex')}`;
}

/** Stores what `body` gives as a new blob of the organization's; a validation error where it is over `maxBytes`. */
export function storeContent(orgId: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Result<StoredContent, ApiError>> {
	return Do(async ($) => {
		const backend = await blobBackend();
		const blob = $(await createFileBlob({orgId, backendId: backend.id, key: newBlobKey(orgId)}));
		return $(await fillBlob(blob, body, maxBytes));
	});
}

/**
 * Stores what `body` gives in a blob whose row is made, as an upload's is at its start, and
 * completes the row; a validation error, saying `tooLarge`, where it is over `maxBytes`. A blob
 * filled again holds what was sent last, as after an upload that failed partway is sent again.
 */
export function fillBlob(
	blob: Pick<FileBlobRow, 'id' | 'backendId' | 'key'>,
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	tooLarge = `A file is at most ${megabytes(maxBytes)}.`,
): Promise<Result<StoredContent, ApiError>> {
	return Do(async ($) => {
		const backend = await blobBackend();
		if (backend.id !== blob.backendId) {
			return $(Err(ApiErr.unavailable('This upload was started for a store this server no longer uses: start it again.')));
		}
		const hasher = new Bun.CryptoHasher('sha256');
		let size = 0;
		const counted = body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					size += chunk.byteLength;
					if (size > maxBytes) {
						controller.error(new Error('The file is too large'));
						return;
					}
					hasher.update(chunk);
					controller.enqueue(chunk);
				},
			}),
		);
		const put = await backend.put(blob.key, counted);
		if (put.isErr() && size > maxBytes) {
			return $(Err(ApiErr.validationError(tooLarge)));
		}
		$(put);
		const stored = $(await completeFileBlob(blob.id, {size, sha256: hasher.digest('hex')}));
		return {blobId: stored.id, size, sha256: stored.sha256 ?? ''};
	});
}

/** Stores text as a new blob, as UTF-8. */
export function storeText(orgId: string, text: string, maxBytes: number): Promise<Result<StoredContent, ApiError>> {
	const bytes = new TextEncoder().encode(text);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	return storeContent(orgId, body, maxBytes);
}

/** A blob's bytes, from the store that took them. */
export function openContent(blob: Pick<FileBlobRow, 'backendId' | 'key'>): Promise<Result<ReadableStream<Uint8Array>, ApiError>> {
	return Do(async ($) => {
		const backend = await blobBackend();
		if (backend.id !== blob.backendId) {
			return $(Err(ApiErr.unavailable('This file’s content is in a store this server no longer uses.')));
		}
		return $(await backend.get(blob.key));
	});
}

/** A blob's bytes, whole in memory: for one known to be small enough to read. */
export function readContent(blob: Pick<FileBlobRow, 'backendId' | 'key'>): Promise<Result<Uint8Array, ApiError>> {
	return Do(async ($) => {
		const stream = $(await openContent(blob));
		const read = await Result.wrapAsync(() => new Response(stream).arrayBuffer());
		return new Uint8Array($(read.mapErr((cause) => ApiErr.providerUnreachable(cause))));
	});
}

const UPLOAD_TYPE = 'application/octet-stream';

/**
 * An upload's body as a stream of its bytes, read from the request as they come. Sent as
 * `application/octet-stream` whatever the file is, so that no parser has read it first, as the
 * JSON one would a `.json` file sent as what it is.
 */
export function uploadBody(request: Request): Result<ReadableStream<Uint8Array>, ApiError> {
	if (!request.is(UPLOAD_TYPE)) {
		return Err(ApiErr.validationError(`An upload’s body is the file, sent as ${UPLOAD_TYPE}`));
	}
	return requestBytes(request);
}

/**
 * A request's body as a stream of its bytes, read as they come, whatever its type says: for a
 * route mounted where no parser reads a body first, as an upload's URL is (upload-route.ts).
 */
export function requestBytes(request: Request): Result<ReadableStream<Uint8Array>, ApiError> {
	const chunks = request[Symbol.asyncIterator]();
	return Result.wrap(
		() =>
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					const next = await chunks.next();
					if (next.done) {
						controller.close();
						return;
					}
					if (next.value instanceof Uint8Array) {
						controller.enqueue(next.value);
					}
				},
				// What is left of a body nobody reads on, as of a file too large, is read and dropped:
				// the answer saying why reaches a browser only once it has sent all of it.
				cancel() {
					request.resume();
				},
			}),
	).mapErr((cause) => ApiErr.internalError(cause));
}

/**
 * Writes a file's bytes to a response as they come, waiting where the reader is slower than the
 * store. The headers are sent by then: one that fails partway is cut off short, which whoever
 * reads it takes as a download that failed. A reader that goes away partway ends it too, and the
 * store's stream is let go of then rather than left waiting on a reader that is gone.
 */
export async function sendContent(response: Response, body: ReadableStream<Uint8Array>): Promise<Result<void, Error>> {
	return Result.wrapAsync<void, Error>(() => pipeline(Readable.from(body), response));
}
