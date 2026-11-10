import {randomBytes} from 'node:crypto';
import {mkdir, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {type BlobBackend, type BlobKey, requireBlobKey} from './backend';

/**
 * The blob store on this machine's disk: each blob a file under `root`, at its key. For
 * self-hosting on one server, with `root` on a volume that is kept, and for development and the
 * tests; servers that share no disk need a store they all reach (s3.ts). A blob is written beside
 * where it goes and moved into place, so a reader finds all of it or none of it.
 */

export const DISK_BLOB_BACKEND = 'disk';

function failed(cause: unknown): ApiError {
	return ApiErr.internalError(cause instanceof Error ? cause : new Error('The blob store’s disk failed'));
}

export function diskBlobBackend(root: string): BlobBackend {
	const pathOf = (key: BlobKey): Result<string, ApiError> => requireBlobKey(key).map((valid) => join(root, valid));

	return {
		id: DISK_BLOB_BACKEND,
		put: async (key, body) => {
			const path = pathOf(key);
			if (path.isErr()) {
				return Err(path.error);
			}
			const partial = `${path.value}.${randomBytes(6).toString('hex')}.part`;
			const written = await Result.wrapAsync(async () => {
				await mkdir(dirname(path.value), {recursive: true});
				const writer = Bun.file(partial).writer();
				try {
					for await (const chunk of body) {
						await writer.write(chunk);
					}
				} finally {
					await writer.end();
				}
				await rename(partial, path.value);
			});
			if (written.isErr()) {
				await rm(partial, {force: true});
				return Err(failed(written.error));
			}
			return Ok(undefined);
		},
		get: async (key) => {
			const path = pathOf(key);
			if (path.isErr()) {
				return Err(path.error);
			}
			const file = Bun.file(path.value);
			const exists = await Result.wrapAsync(() => file.exists());
			if (exists.isErr()) {
				return Err(failed(exists.error));
			}
			if (!exists.value) {
				return Err(ApiErr.notFound('blob', key));
			}
			return Ok(file.stream());
		},
		delete: async (key) => {
			const path = pathOf(key);
			if (path.isErr()) {
				return Err(path.error);
			}
			return (await Result.wrapAsync(() => rm(path.value, {force: true}))).mapErr(failed);
		},
	};
}
