import {S3Client} from 'bun';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {type BlobBackend, requireBlobKey} from './backend';

/**
 * The blob store in a bucket that speaks S3's protocol, Amazon's or any other's, as Cloudflare
 * R2's and MinIO's do: each blob an object at its key, under `prefix` where one is given, so a
 * bucket can hold more than this. For servers that share no disk, hosted Personal Agent Proxy's
 * among them. A blob is uploaded in parts as it comes, never held whole in memory, and an upload
 * that fails partway is given up, so the bucket keeps nothing of it.
 */

export const S3_BLOB_BACKEND = 's3';

export type S3BlobConfig = {
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** The store's address, for one that isn't Amazon's. */
	endpoint?: string;
	region?: string;
	/** What every key goes under in the bucket, without slashes around it. */
	prefix?: string;
};

function failed(cause: unknown): ApiError {
	return ApiErr.providerUnreachable(cause instanceof Error ? cause : new Error('The blob store’s bucket failed'));
}

export function s3BlobBackend(config: S3BlobConfig): BlobBackend {
	const {prefix, ...options} = config;
	const client = new S3Client(options);
	const objectOf = (key: string) => requireBlobKey(key).map((valid) => client.file(prefix ? `${prefix}/${valid}` : valid));

	return {
		id: S3_BLOB_BACKEND,
		put: async (key, body) => {
			const object = objectOf(key);
			if (object.isErr()) {
				return Err(object.error);
			}
			const writer = object.value.writer();
			const written = await Result.wrapAsync(async () => {
				for await (const chunk of body) {
					await writer.write(chunk);
				}
				await writer.end();
			});
			if (written.isErr()) {
				// Ends the upload, then removes what the bucket took of it, since ending one that sent
				// less than a part sends what it has; the failure that matters is the one in hand.
				await Result.wrapAsync(async () => {
					await writer.end(written.error instanceof Error ? written.error : new Error('The upload failed'));
				});
				await Result.wrapAsync(() => object.value.delete());
				return Err(failed(written.error));
			}
			return Ok(undefined);
		},
		get: async (key) => {
			const object = objectOf(key);
			if (object.isErr()) {
				return Err(object.error);
			}
			const exists = await Result.wrapAsync(() => object.value.exists());
			if (exists.isErr()) {
				return Err(failed(exists.error));
			}
			if (!exists.value) {
				return Err(ApiErr.notFound('blob', key));
			}
			return Ok(object.value.stream());
		},
		delete: async (key) => {
			const object = objectOf(key);
			if (object.isErr()) {
				return Err(object.error);
			}
			return (await Result.wrapAsync(() => object.value.delete())).mapErr(failed);
		},
	};
}
