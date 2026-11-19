import {expireFileUpload, listExpiredFileUploads} from '@proxy/db/file-uploads';

import {log, serializeError} from '../observability/log';
import {UPLOAD_TTL_MS} from './tickets';

/**
 * Lets go of uploads nobody finished (tickets.ts), a few at a time every ten minutes: one past its
 * hour that no bytes are in for or coming in for, and any still open an hour after that, its bytes
 * in but files_upload_done never called, or a PUT that never ended. Nothing reached a drive before
 * done, so letting one go is only marking it expired; its blob is left to the sweep of unused blobs
 * (native/files/sweeper.ts). Each api instance sweeps; an upload expired twice is expired once.
 */

const SWEEP_MS = 10 * 60_000;
const BATCH = 100;

export async function sweepUploads(now = new Date()): Promise<void> {
	const expired = await listExpiredFileUploads({now, graceMs: UPLOAD_TTL_MS, limit: BATCH});
	if (expired.isErr()) {
		log.error('The uploads sweeper could not list uploads', serializeError(expired.error));
		return;
	}
	for (const upload of expired.value) {
		const marked = await expireFileUpload(upload.id);
		if (marked.isErr()) {
			log.warn('An upload could not be marked expired', {uploadId: upload.id, ...serializeError(marked.error)});
		}
	}
}

/** Starts the sweeper. */
export function startUploadsSweeper(): void {
	setInterval(() => void sweepUploads(), SWEEP_MS).unref();
}
