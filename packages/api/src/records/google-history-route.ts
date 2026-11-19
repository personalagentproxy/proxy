import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {type DriveChange, type driveFileHistorySchema, type driveHistoryListSchema, type DriveVersion, restoreDriveVersionBodySchema} from '@proxy/contracts/drive-history';
import {type FileActor, type FileChangeEntry, type FileVersionEntry, listChangedFiles} from '@proxy/db/files';

import {isGoogleType} from '../connections/google/drive-api';
import {GOOGLE_INTEGRATION} from '../connections/google/integration';
import {toFileAuthor} from '../native/files/route';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {isRestorable, readDriveHistory, restoreDriveVersion, undoDriveChange, type DriveFileHistory} from './google-versions';
import {loadConnection, type LoadedConnection} from './target';

/**
 * Personal Agent Proxy's history of a Google connection's files in Drive, on the connection's page
 * (google-history.ts): the files changed through it, and a file's versions and changes. A member
 * who uses the connection gives a version back and undoes a change with an exact undo from there,
 * through what `files_restore` and `files_undo` run (google-versions.ts), logged in the history as
 * the member's, unlogged in the activity log as the person's own doings are.
 */

// How many files the page lists, the latest changed.
const FILES_LISTED = 100;

type Drive = {connection: LoadedConnection['connection']; by: FileActor};

// The Google connection the address names, among those the person uses, and who they are.
function driveOf(request: AuthenticatedRequest): Promise<Result<Drive, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const {connection, integration} = $(await loadConnection(viewer, connectionId));
		if (integration.id !== GOOGLE_INTEGRATION.id) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
		return {connection, by: {userId: viewer.userId}};
	});
}

// A version as the page shows it: who made the change it is the copy from before, as
// `files_versions` says first, or else who made it, as a restore makes one.
function toVersion(version: FileVersionEntry, history: DriveFileHistory): DriveVersion {
	const before = history.changes.find((change) => change.beforeVersion === version.id);
	const origin = before ? 'before' : version.author === null ? null : 'made';
	const author = before ?? version.author;
	return {
		id: version.id,
		at: version.createdAt.toISOString(),
		kept: version.blobId === null ? 'drive' : 'here',
		size: version.size,
		type: version.type,
		pinned: version.pinned,
		restorable: isRestorable(history.file, version),
		origin,
		by: author ? toFileAuthor(author) : null,
	};
}

function toChange(change: FileChangeEntry): DriveChange {
	return {
		id: change.id,
		at: change.createdAt.toISOString(),
		kind: change.kind,
		name: change.name,
		beforeName: change.beforeName,
		by: toFileAuthor(change),
		cells: change.undo === null ? null : {tab: change.undo.tab, range: change.undo.range},
	};
}

/** `GET drive-history`: the files changed through Personal Agent Proxy, the latest changed first. */
export function handleListDriveHistoryRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof driveHistoryListSchema>, ApiError>> {
	return Do(async ($) => {
		const {connection} = $(await driveOf(request));
		const latest = $(await listChangedFiles(connection.id, FILES_LISTED));
		return {
			files: latest.map((change) => ({id: change.fileId, name: change.name, at: change.createdAt.toISOString(), kind: change.kind, by: toFileAuthor(change)})),
		};
	});
}

/** `GET drive-history/:fileId`: the file as Drive has it now, with its versions and changes. */
export function handleGetDriveHistoryRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof driveFileHistorySchema>, ApiError>> {
	return Do(async ($) => {
		const {connection} = $(await driveOf(request));
		const history = $(await readDriveHistory(connection, request.params.fileId ?? ''));
		const {file} = history;
		return {
			file: {id: file.id, name: file.name, link: file.webViewLink ?? null, google: isGoogleType(file.mimeType)},
			versions: history.versions.map((version) => toVersion(version, history)),
			changes: history.changes.map(toChange),
		};
	});
}

/** `POST drive-history/:fileId/restore`: a version given back as the file's newest revision in Drive, as the member's. */
export function handleRestoreDriveVersionRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {connection, by} = $(await driveOf(request));
		const {version} = $(parseSchema(restoreDriveVersionBodySchema, request.body));
		$(await restoreDriveVersion(connection, by, request.params.fileId ?? '', version));
	});
}

/** `POST drive-history/:fileId/changes/:changeId/undo`: a change of the file undone exactly, as the member's. */
export function handleUndoDriveChangeRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {connection, by} = $(await driveOf(request));
		$(await undoDriveChange(connection, by, request.params.changeId ?? '', request.params.fileId ?? ''));
	});
}
