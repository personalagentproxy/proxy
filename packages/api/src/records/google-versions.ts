import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {
	type FileActor,
	type FileChangeEntry,
	type FileChangeRow,
	type FileUndo,
	type FileVersionEntry,
	type FileVersionFound,
	type FileVersionRow,
	findFileVersion,
	getFileChange,
	isStored,
	listFileChanges,
	listFileVersions,
} from '@proxy/db/files';

import {downloadRevision, driveVersion, fileIdOf, getFileState, isGoogleType, putContent, type DriveFileState} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {openContent} from '../native/files/content';
import {readParams, type NativeToolRunner} from '../native/tool';
import {applyCellsUndo} from './google-cells';
import {changeBy, changeDriveFile, runActor, type DriveChange, type DriveChangeEntry, type DriveEditor} from './google-history';

/**
 * The Google tools on a Drive file's history (google-history.ts): `files_versions` lists the
 * versions Personal Agent Proxy keeps of it, each a copy taken before a task first changed it, kept
 * here or only as Drive's own revision, and the changes made through it, who made each and for
 * which task; `files_restore` gives a version back as the file's newest revision in Drive, keeping
 * its id; `files_undo` applies a change's exact inverse, a Sheet's cells put back as they were.
 * A restore and an undo are changes of their own, logged and copied before as any other. The web
 * app's routes on a Drive file's history (google-history-route.ts) read, restore and undo through
 * the same functions, as the member.
 */

/** A Google connection, as its history and its token are read by. */
type DriveConnection = {id: string; orgId: string; credential: string | null};

// How many of a file's changes `files_versions` lists, the latest.
const CHANGES_LISTED = 50;

function requireFileId(given: string): Result<string, ApiError> {
	return requirePresent(fileIdOf(given), ApiErr.validationError('Say which file as id: its id, as files_list gives it, or its link'));
}

// Who made a change: the member, or the agent as its maker, with the task it was for.
function whoText(change: FileChangeEntry): string {
	if (change.user !== null) {
		return `by ${change.user.name ?? change.user.email}`;
	}
	const who = change.maker?.name ?? 'an agent';
	return change.task === null ? `by ${who}` : `by ${who} for “${change.task.title}”`;
}

function changeText(change: FileChangeEntry): string {
	if (change.kind === 'create') {
		return 'made';
	}
	if (change.kind === 'move') {
		return change.beforeName === null ? 'renamed' : `renamed from “${change.beforeName}”`;
	}
	if (change.kind === 'trash') {
		return 'moved to Trash';
	}
	if (change.kind === 'untrash') {
		return 'taken out of Trash';
	}
	if (change.kind === 'restore') {
		return 'given an earlier version back';
	}
	if (change.kind === 'write') {
		return 'written over';
	}
	if (change.undo !== null) {
		return `edited, cells ${change.undo.range} of “${change.undo.tab}”`;
	}
	return 'edited';
}

function changeLine(change: FileChangeEntry): string {
	const undo = change.undo === null ? '' : '; files_undo undoes it exactly';
	return `${change.id}: ${change.createdAt.toISOString()}, ${changeText(change)} ${whoText(change)}${undo}`;
}

// Where a version is kept: its bytes here, or only Drive's revision, pinned there or not.
function keptText(version: FileVersionEntry): string {
	const revision = version.sourceRevision === null ? '' : `, Drive’s revision ${version.sourceRevision}`;
	if (isStored(version)) {
		return `kept here, ${formatBytes(version.size)} as ${version.type}${revision}`;
	}
	const pinned = version.pinned ? ', which Drive keeps for good meanwhile' : '';
	return `kept only in Drive${revision}${pinned}`;
}

// What a version is: the copy of what the file held before a change, or what a restore gave back.
function originText(version: FileVersionEntry, changes: FileChangeEntry[]): string {
	const before = changes.find((change) => change.beforeVersion === version.id);
	if (before) {
		return `; what it held before it was ${changeText(before)} ${whoText(before)}`;
	}
	const made = changes.find((change) => change.afterVersion === version.id);
	return made ? `; ${changeText(made)} ${whoText(made)}` : '';
}

function versionLine(version: FileVersionEntry, changes: FileChangeEntry[]): string {
	return `${version.id}: ${version.createdAt.toISOString()}, ${keptText(version)}${originText(version, changes)}`;
}

/** A Drive file's history as Personal Agent Proxy keeps it: the file as Drive has it now, its versions, newest first, and its latest changes. */
export type DriveFileHistory = {file: DriveFileState; versions: FileVersionEntry[]; changes: FileChangeEntry[]};

/** A Drive file's history, by its id or its link. */
export function readDriveHistory(connection: DriveConnection, given: string): Promise<Result<DriveFileHistory, ApiError>> {
	return Do(async ($) => {
		const fileId = $(requireFileId(given));
		const file = $(await callGoogle(connection, (token) => getFileState(token, fileId)));
		const [versions, changes] = await Promise.all([listFileVersions(connection.id, file.id), listFileChanges(connection.id, file.id, CHANGES_LISTED)]);
		return {file, versions: $(versions), changes: $(changes)};
	});
}

const idSchema = z.object({id: z.string().min(1)});

/** `files_versions`: the versions Personal Agent Proxy keeps of a Drive file, and the changes made to it through it. */
export const runFilesVersions: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(readParams(idSchema, 'files_versions', 'id', run.params));
		const {file, versions, changes} = $(await readDriveHistory(run.connection, id));
		const versionLines = versions.map((version) => versionLine(version, changes));
		const changeLines = changes.map(changeLine);
		const link = file.webViewLink ? [`Link: ${file.webViewLink}`] : [];
		const current = driveVersion(file);
		const now = current === null ? [] : [`Version in Drive now: ${current}, which files_upload takes to write over it`];
		return [
			`“${file.name}”, as Personal Agent Proxy keeps its history. Drive’s own version history (File > Version history in Docs, Sheets and Slides) has every revision.`,
			...link,
			...now,
			'',
			versionLines.length === 0 ? 'No versions kept: a copy is kept before a task first changes the file.' : 'Versions, newest first; files_restore gives one back:',
			...versionLines,
			'',
			changeLines.length === 0 ? 'No changes made through Personal Agent Proxy.' : 'Changes, newest first:',
			...changeLines,
		].join('\n');
	});

/**
 * Whether a version can be given back from here: one with a copy can, and an uploaded file's kept
 * only as Drive's revision; a Doc's, Sheet's or Slides file's kept only in Drive is given back in
 * Drive's own version history, which Drive's API can't do.
 */
export function isRestorable(file: {mimeType: string}, version: FileVersionRow): boolean {
	return version.blobId !== null || (!isGoogleType(file.mimeType) && version.sourceRevision !== null);
}

// A version that can be given back from here, or why not and where it can be instead.
function requireRestorable(file: DriveFileState, version: FileVersionFound): Result<void, ApiError> {
	if (isRestorable(file, version)) {
		return Ok(undefined);
	}
	const when = version.createdAt.toISOString();
	const where = file.webViewLink ? ` at ${file.webViewLink}` : '';
	return Err(
		ApiErr.validationError(
			`Personal Agent Proxy kept no copy of version ${version.id}, only Drive’s revision of ${when}: give it back in Drive’s own version history, File > Version history > See version history${where}, picking the version from that time`,
		),
	);
}

// What a version's bytes are, to put back: its copy here, or its revision downloaded from Drive.
function bytesOf(token: string, file: DriveFileState, version: FileVersionFound): Promise<Result<{type: string; body: ReadableStream<Uint8Array>; size: number | null}, ApiError>> {
	return Do(async ($) => {
		if (version.blob !== null) {
			return {type: version.type, body: $(await openContent(version.blob)), size: version.blob.size};
		}
		const revision = $(requirePresent(version.sourceRevision, ApiErr.notFound('version', version.id, 'That version has no copy and no revision in Drive to give back')));
		const body = await downloadRevision(token, file.id, revision);
		if (body.isErr() && body.error.kind === 'not_found') {
			return $(Err(ApiErr.conflict(`Drive no longer keeps the revision that version ${version.id} points at, so it can’t be given back`)));
		}
		return {type: version.type, body: $(body), size: version.size};
	});
}

/** A file given an earlier version back, and the version keeping what it held just before, where this restore kept one. */
type Restored = {file: DriveFileState; keptBefore: string | null};

// A version put back in place of what the file holds, as its newest revision in Drive; logged as a
// restore that made a version holding the same as the one given back.
function restore(editor: DriveEditor, change: DriveChange, file: DriveFileState, version: FileVersionFound): Promise<Result<{done: Restored; entry: DriveChangeEntry}, ApiError>> {
	return Do(async ($) => {
		const bytes = $(await bytesOf(editor.token, file, version));
		const restored = $(await putContent(editor.token, file.id, bytes));
		const made = {blobId: version.blobId, size: version.size, type: version.type, sourceType: version.sourceType};
		return {done: {file: restored, keptBefore: change.beforeVersion}, entry: {kind: 'restore', made}};
	});
}

// What a restore says of what the file held until it: kept by it, or by the task's first change.
function keptBeforeText(restored: Restored): string {
	if (restored.keptBefore !== null) {
		return `what it held until now is kept as version ${restored.keptBefore}`;
	}
	return 'what it held until now is not kept again: this task kept its copy before its first change to the file (files_versions lists it)';
}

// The file as it is now, and the version put back in place of what it holds.
function restoreIn(editor: DriveEditor, fileId: string, version: FileVersionFound): Promise<Result<Restored, ApiError>> {
	return Do(async ($) => {
		const file = $(await getFileState(editor.token, fileId));
		$(requireRestorable(file, version));
		return $(await changeDriveFile(editor, file.id, {content: true}, (change) => restore(editor, change, file, version)));
	});
}

/**
 * A version given back as the file's newest revision, keeping its id: an uploaded file's bytes as
 * they were, a Doc's, Sheet's or Slides file's copy converted back into what it is. Logged as a
 * restore by `by`.
 */
export function restoreDriveVersion(connection: DriveConnection, by: FileActor, given: string, versionId: string): Promise<Result<Restored & {version: FileVersionFound}, ApiError>> {
	return Do(async ($) => {
		const fileId = $(requireFileId(given));
		const found = $(await findFileVersion(connection.id, fileId, versionId));
		const version = $(requirePresent(found, ApiErr.notFound('version', versionId, 'That file has no such version: files_versions lists them')));
		const restored = $(await callGoogle(connection, (token) => restoreIn({token, change: changeBy(connection, by)}, fileId, version)));
		return {...restored, version};
	});
}

const restoreSchema = z.object({id: z.string().min(1), version: z.string().min(1)});

/** `files_restore`: a version given back as the file's newest revision, keeping its id (`restoreDriveVersion`). */
export const runFilesRestore: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const params = $(readParams(restoreSchema, 'files_restore', 'id and version', run.params));
		const restored = $(await restoreDriveVersion(run.connection, runActor(run), params.id, params.version));
		const link = restored.file.webViewLink ? [`Link: ${restored.file.webViewLink}`] : [];
		return [`“${restored.file.name}” holds what version ${restored.version.id} held again, as its newest revision in Drive; ${keptBeforeText(restored)}.`, ...link].join('\n');
	});

// A change's cells put back, logged as an edit whose undo is the undo's own inverse.
function undoCells(editor: DriveEditor, change: FileChangeRow, undo: FileUndo): Promise<Result<FileUndo, ApiError>> {
	return changeDriveFile(editor, change.fileId, {content: true}, () =>
		Do(async ($) => {
			const inverse = $(await applyCellsUndo(editor.token, change.fileId, undo));
			return {done: inverse, entry: {kind: 'edit', undo: inverse}};
		}),
	);
}

/** A change undone: the change, and the cells it put back. */
type Undone = {change: FileChangeRow; undo: FileUndo};

/**
 * A change's exact inverse applied, where it has one and nothing changed it since, logged as an
 * edit by `by`; with `fileId`, only a change of that file.
 */
export function undoDriveChange(connection: DriveConnection, by: FileActor, changeId: string, fileId?: string): Promise<Result<Undone, ApiError>> {
	return Do(async ($) => {
		const found = $(await getFileChange(connection.id, changeId));
		const missing = ApiErr.notFound('change', changeId, 'This connection made no such change: files_versions lists a file’s changes');
		const change = $(requirePresent(found !== null && (fileId === undefined || found.fileId === fileId) ? found : null, missing));
		const {undo} = change;
		if (undo === null) {
			const from = change.beforeVersion === null ? '' : `, ${change.beforeVersion},`;
			return $(Err(ApiErr.validationError(`That change has no exact undo: give back the version from before it${from} with files_restore instead (files_versions lists them)`)));
		}
		$(await callGoogle(connection, (token) => undoCells({token, change: changeBy(connection, by)}, change, undo)));
		return {change, undo};
	});
}

const undoSchema = z.object({change: z.string().min(1)});

/** `files_undo`: a change's exact inverse applied, where it has one and nothing changed it since (`undoDriveChange`). */
export const runFilesUndo: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {change: changeId} = $(readParams(undoSchema, 'files_undo', 'change', run.params));
		const {change, undo} = $(await undoDriveChange(run.connection, runActor(run), changeId));
		return `Put cells ${undo.range} of “${undo.tab}” in “${change.name}” back as they were before change ${change.id}. The undo is a change of its own, which files_undo can undo in turn (files_versions lists it).`;
	});
