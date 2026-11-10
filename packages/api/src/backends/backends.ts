import {join} from 'node:path';
import {tmpdir} from 'node:os';

import type {BlobBackend} from '@proxy/backends/blob/backend';
import {diskBlobBackend} from '@proxy/backends/blob/disk';
import {s3BlobBackend} from '@proxy/backends/blob/s3';
import type {SandboxBackend} from '@proxy/backends/sandbox/backend';
import {remoteSandboxBackend} from '@proxy/backends/sandbox/remote';
import {tempDirSandboxBackend} from '@proxy/backends/sandbox/temp-dir';

import {log} from '../observability/log';
import {getContext} from '../observability/request-context';

/**
 * The backends this server runs with: what runs the machines, and keeps the bytes, a capability
 * of Personal Agent Proxy's own needs, each behind the contract `@proxy/backends` owns and chosen
 * by the environment; without one there is no capability, which the catalog then leaves out.
 *
 * Sandboxes: without SANDBOX_SERVICE_URL there is no backend; with it, a service elsewhere that
 * speaks the protocol, hosted Personal Agent Proxy's own among them; `dev` is the one the tests
 * run on, a directory on this machine with no isolation at all, which only a development server
 * takes.
 *
 * Files: their bytes go to a bucket that speaks S3's protocol, where FILES_S3_BUCKET names one,
 * with its keys beside it, or else to a directory on this server, FILES_DIR; without either
 * there are no Files.
 *
 * Chosen once, the first time anything asks; a choice that can't be made is logged and is none.
 */

// Chosen once, the first time anything asks, rather than as this module loads: the environment
// is read then, as host-check.ts reads it, which the tests of what reaches sandboxes never do.
let chosen: Promise<SandboxBackend | null> | undefined;

async function chooseSandboxBackend(): Promise<SandboxBackend | null> {
	const {env} = await import('../utils/env');
	if (env.SANDBOX_SERVICE_URL === undefined) {
		return null;
	}
	if (env.SANDBOX_SERVICE_URL === 'dev') {
		if (env.NODE_ENV !== 'development') {
			log.error('SANDBOX_SERVICE_URL=dev runs commands on this machine with no isolation, so only a development server takes it; sandboxes are off');
			return null;
		}
		return tempDirSandboxBackend(join(tmpdir(), 'proxy-sandboxes'));
	}
	if (!env.SANDBOX_SERVICE_TOKEN) {
		log.error('SANDBOX_SERVICE_URL needs SANDBOX_SERVICE_TOKEN beside it; sandboxes are off');
		return null;
	}
	return remoteSandboxBackend({
		url: env.SANDBOX_SERVICE_URL,
		token: env.SANDBOX_SERVICE_TOKEN,
		// The request's id, or the built-in agent's job's, so the service's lines carry it too.
		headers: (): Record<string, string> => {
			const context = getContext();
			const id = context?.requestId ?? context?.jobId;
			return id === undefined ? {} : {'x-request-id': id};
		},
	});
}

/** The server's sandbox backend, or null where sandboxes are off. */
export function sandboxBackend(): Promise<SandboxBackend | null> {
	chosen ??= chooseSandboxBackend();
	return chosen;
}

let chosenBlobs: Promise<BlobBackend | null> | undefined;

async function chooseBlobBackend(): Promise<BlobBackend | null> {
	const {env} = await import('../utils/env');
	if (env.FILES_S3_BUCKET !== undefined) {
		if (!env.FILES_S3_ACCESS_KEY_ID || !env.FILES_S3_SECRET_ACCESS_KEY) {
			log.error('FILES_S3_BUCKET needs FILES_S3_ACCESS_KEY_ID and FILES_S3_SECRET_ACCESS_KEY beside it; Files are off');
			return null;
		}
		return s3BlobBackend({
			bucket: env.FILES_S3_BUCKET,
			accessKeyId: env.FILES_S3_ACCESS_KEY_ID,
			secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY,
			endpoint: env.FILES_S3_ENDPOINT,
			region: env.FILES_S3_REGION,
			prefix: env.FILES_S3_PREFIX,
		});
	}
	if (env.FILES_DIR !== undefined) {
		return diskBlobBackend(env.FILES_DIR);
	}
	return null;
}

/** The server's blob backend, where the bytes of Files are kept, or null where Files are off. */
export function blobBackend(): Promise<BlobBackend | null> {
	chosenBlobs ??= chooseBlobBackend();
	return chosenBlobs;
}
