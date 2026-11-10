import {deleteUnusedFileBlob, listTrashedBefore, listUnusedFileBlobs, purgeTrashed} from '@proxy/db/files';
import {FILES_TRASH_DAYS} from '@proxy/integrations';

import {blobBackend} from '../../backends/backends';
import {log, serializeError} from '../../observability/log';

/**
 * Cleans up after Files, a few at a time every ten minutes: what has been in the trash for as
 * long as it is kept is deleted for good, with everything inside it and their versions; and a
 * blob no version points at any more, such a file's, a deleted drive's or an upload's that was
 * given up, is removed from the store and then forgotten. A blob is left a day first, so one
 * being uploaded now, which no version points at yet, is never taken. Each api instance sweeps;
 * removing a blob twice is no error, and a purge finds nothing to do where another did it.
 */

const SWEEP_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BATCH = 100;

async function purgeOldTrash(now: Date): Promise<void> {
	const old = await listTrashedBefore(new Date(now.getTime() - FILES_TRASH_DAYS * DAY_MS), BATCH);
	if (old.isErr()) {
		log.error('The files sweeper could not list the trash', serializeError(old.error));
		return;
	}
	for (const {id, connectionId} of old.value) {
		const purged = await purgeTrashed(connectionId, id);
		if (purged.isErr()) {
			log.warn('A trashed file could not be deleted', {fileId: id, ...serializeError(purged.error)});
		}
	}
}

async function removeUnusedBlobs(now: Date): Promise<void> {
	const backend = await blobBackend();
	if (backend === null) {
		return;
	}
	const unused = await listUnusedFileBlobs(new Date(now.getTime() - DAY_MS), BATCH);
	if (unused.isErr()) {
		log.error('The files sweeper could not list blobs', serializeError(unused.error));
		return;
	}
	for (const blob of unused.value) {
		// One another backend took is left where it is: this server can't reach it to remove it.
		if (blob.backendId !== backend.id) {
			continue;
		}
		const removed = await backend.delete(blob.key);
		if (removed.isErr()) {
			log.warn('A blob could not be removed from the store', {blobId: blob.id, ...serializeError(removed.error)});
			continue;
		}
		const forgotten = await deleteUnusedFileBlob(blob.id);
		if (forgotten.isErr()) {
			log.warn('A removed blob could not be forgotten', {blobId: blob.id, ...serializeError(forgotten.error)});
		}
	}
}

export async function sweepFiles(now = new Date()): Promise<void> {
	await purgeOldTrash(now);
	await removeUnusedBlobs(now);
}

/** Starts the sweeper, where the server has a blob store. */
export async function startFilesSweeper(): Promise<void> {
	if ((await blobBackend()) === null) {
		return;
	}
	setInterval(() => void sweepFiles(), SWEEP_MS).unref();
}
