import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

/**
 * What a blob store is to the api: where the bytes of the files kept in Personal Agent Proxy
 * itself live, run by a backend. The api owns everything about a file but its bytes: its name,
 * where it is, its versions and who made them (native/files); a backend holds bytes under the
 * keys the api names and is asked for nothing but these three things. A blob is written once and
 * never changed: a file's new version is a new blob under a new key, so a backend needs no
 * versions, no listing and no names of its own. Every backend passes the same tests
 * (conformance.ts), the one the tests use among them (disk.ts).
 */

/**
 * The api's name for a blob: segments of letters, digits, `-` and `_`, with `/` between them, as
 * `<organization>/<blob>`. A backend refuses any other, so a key is never a path out of where the
 * backend keeps its blobs.
 */
export type BlobKey = string;

const KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/** The key where it is one a backend takes; a validation error for any other. */
export function requireBlobKey(key: BlobKey): Result<BlobKey, ApiError> {
	if (!KEY.test(key)) {
		return Err(ApiErr.validationError('A blob’s key is letters, digits, - and _, in segments with / between them'));
	}
	return Ok(key);
}

export type BlobBackend = {
	/** Which backend it is, kept with each blob, so one backend is never asked for another's. */
	id: string;
	/**
	 * Keeps what `body` gives under `key`, all of it or nothing: a body that fails partway leaves no
	 * blob, and the failure is the answer. A key written again holds what was written last.
	 */
	put: (key: BlobKey, body: ReadableStream<Uint8Array>) => Promise<Result<void, ApiError>>;
	/** The blob's bytes, from the first; not found for a key nothing is kept under. */
	get: (key: BlobKey) => Promise<Result<ReadableStream<Uint8Array>, ApiError>>;
	/** Removes the blob for good; a key nothing is kept under is removed already. */
	delete: (key: BlobKey) => Promise<Result<void, ApiError>>;
};
