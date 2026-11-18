import {Ok} from 'ts-results-es';

import {expireFileUpload, listExpiredFileUploads} from '@proxy/db/file-uploads';

import {apiIntegration} from '../connections/integrations';
import {log, serializeError} from '../observability/log';
import {type Expiry, UPLOAD_TTL_MS} from './tickets';

/**
 * Lets go of uploads nobody finished (tickets.ts), a few at a time every ten minutes: one past its
 * hour that no bytes are in for or coming in for, and any still open an hour after that, its bytes
 * in but files_upload_done never called, or a PUT that never ended. Each is marked expired once its
 * drive lets go of what it holds there (tickets.ts DriveUploads `expire`): Google Drive cancels a
 * session the bytes are still coming to, and keeps one they are all in for done until an hour past
 * its own, then takes them back out of Drive; a blob of the store here is left to the sweep of
 * unused blobs (native/files/sweeper.ts). One the drive keeps, or can't let go of now, is asked
 * again at the next sweep. Each api instance sweeps; an upload expired twice is expired once.
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
		const uploads = apiIntegration(upload.integrationId)?.uploads;
		const letGo = uploads === undefined ? Ok<Expiry>('let-go') : await uploads.expire(upload, now);
		if (letGo.isErr()) {
			log.warn('An expired upload could not be let go of at its drive', {uploadId: upload.id, kind: letGo.error.kind});
			continue;
		}
		if (letGo.value === 'kept') {
			continue;
		}
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
