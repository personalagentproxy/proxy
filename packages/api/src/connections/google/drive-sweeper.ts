import {getConnectionWithCredentialById} from '@proxy/db/connection';
import {dropFileVersionCopy, listOldFileCopies, listOldPinnedVersions, unpinFileVersion, type FileVersionRow} from '@proxy/db/files';

import {log, serializeError} from '../../observability/log';
import {env} from '../../utils/env';
import {keepRevision} from './drive-api';
import {callGoogle} from './google-client';

/**
 * Lets go of the history kept of Google Drive files (records/google-history.ts) once it is
 * `DRIVE_COPY_KEEP_DAYS` old, a few at a time every ten minutes: a copy's bytes, whose version stays,
 * with its size and Drive's revision, its blob left to the sweep of unused blobs
 * (native/files/sweeper.ts); and a revision pinned in Drive in place of a copy, released there to
 * be kept for good no longer. A pin whose file or revision Drive no longer has is released here
 * too; one Drive can't be asked about now, as when the connection's sign-in was turned down, is
 * left for the next sweep. Each api instance sweeps; a copy let go twice is let go once.
 */

const SWEEP_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BATCH = 100;

const GOOGLE = 'google';

async function dropOldCopies(before: Date): Promise<void> {
	const old = await listOldFileCopies({integrationId: GOOGLE, before, limit: BATCH});
	if (old.isErr()) {
		log.error('The Drive history sweeper could not list copies', serializeError(old.error));
		return;
	}
	for (const version of old.value) {
		const dropped = await dropFileVersionCopy(version);
		if (dropped.isErr()) {
			log.warn('A copy of a Drive file could not be let go', {versionId: version.id, ...serializeError(dropped.error)});
		}
	}
}

async function releasePin(version: FileVersionRow): Promise<void> {
	const connection = await getConnectionWithCredentialById(version.connectionId);
	if (connection.isErr()) {
		log.warn('A pinned Drive revision’s connection could not be read', {versionId: version.id, ...serializeError(connection.error)});
		return;
	}
	const revision = version.sourceRevision;
	if (connection.value !== null && revision !== null) {
		const released = await callGoogle(connection.value, (token) => keepRevision(token, version.fileId, revision, false));
		if (released.isErr() && released.error.kind !== 'not_found') {
			log.warn('A pinned Drive revision could not be released', {versionId: version.id, kind: released.error.kind});
			return;
		}
	}
	const unpinned = await unpinFileVersion(version);
	if (unpinned.isErr()) {
		log.warn('A released Drive revision could not be marked so', {versionId: version.id, ...serializeError(unpinned.error)});
	}
}

export async function sweepDriveHistory(now = new Date()): Promise<void> {
	const before = new Date(now.getTime() - env.DRIVE_COPY_KEEP_DAYS * DAY_MS);
	await dropOldCopies(before);
	const pinned = await listOldPinnedVersions({integrationId: GOOGLE, before, limit: BATCH});
	if (pinned.isErr()) {
		log.error('The Drive history sweeper could not list pinned revisions', serializeError(pinned.error));
		return;
	}
	for (const version of pinned.value) {
		await releasePin(version);
	}
}

/** Starts the sweeper. */
export function startDriveSweeper(): void {
	setInterval(() => void sweepDriveHistory(), SWEEP_MS).unref();
}
