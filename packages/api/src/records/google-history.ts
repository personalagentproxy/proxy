import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {
	type FileActor,
	type FileChangeBy,
	type FileChangeKind,
	type FileChangeRow,
	type FileUndo,
	type FileVersionFound,
	type FileVersionRow,
	getLatestFileVersion,
	hasTaskCopied,
	logFileChange,
	recordFileVersion,
	type RecordedContent,
} from '@proxy/db/files';

import {blobBackend} from '../backends/backends';
import {downloadFile, exportBytes, getFileState, isGoogleType, keepRevision, latestRevision, MIME_TYPES, OFFICE_TYPES, type DriveFileState} from '../connections/google/drive-api';
import {storeContent, type StoredContent} from '../native/files/content';
import {log} from '../observability/log';
import {env} from '../utils/env';

/**
 * Personal Agent Proxy's history of a Google Drive file (db/files.ts FileVersion and FileChange,
 * by the Google connection's id and the file's id in Drive): every write the Google records and
 * tools make to a file in Drive goes through here, and is logged as whoever made it, an agent for
 * one of its tasks or a member, with Drive's revisions of the file before and after it.
 *
 * Before a task's first change to what a file holds, a copy of it is kept: a file with bytes of
 * its own, a PDF or a picture, as those bytes, in the blob store, and a Doc, Sheet or Slides file
 * as the docx, xlsx or pptx Drive exports, each with Drive's revision it was taken of. One past
 * `DRIVE_COPY_MAX_MB` is not copied: an uploaded file's revision is kept for good in Drive instead
 * (pinned), and a Doc's revision only noted, for Drive's own version history. A copy that the
 * latest version holds already, the same revision or the same bytes, is not taken again. A member
 * has no task: a copy is kept before each of their changes, unless the latest version holds what
 * the file holds now. A rename or a move to Trash leaves the content alone and takes no copy.
 *
 * A write made in one call is `changeDriveFile`; one that starts in one call and ends in another,
 * as an upload over a file does, takes its copy with `beginDriveChange` at the start and logs with
 * `logDriveChange` at the end. A copy that can't be kept refuses the write before anything is
 * written; once Drive has the write, it is answered as done even where logging it fails, which is
 * then logged on the server.
 */

/** Who changes a Drive's files and the token they do it with: the Google connection, and the agent for its task or the member. */
export type DriveEditor = {token: string; change: FileChangeBy};

/** The change log's entry for a write to one of a Google connection's files, by whoever makes it. */
export function changeBy(connection: {id: string; orgId: string}, by: FileActor): FileChangeBy {
	return {orgId: connection.orgId, connectionId: connection.id, by};
}

/** A change about to be made to a file, as its log needs it: plain values, to be kept between the calls of a change made in two. */
export type DriveChange = {
	fileId: string;
	/** The file's name before the change. */
	name: string;
	mimeType: string;
	/** Drive's revision of the file before the change: its head revision, or a Doc's, Sheet's or Slides file's latest. */
	beforeRevision: string | null;
	/** The version kept before the change, the copy taken for the task's first change to the file; null for none. */
	beforeVersion: string | null;
};

/** What a change was, as it is logged once made. */
export type DriveChangeEntry = {
	kind: FileChangeKind;
	/** The file's name after the change; left out, the one before. */
	name?: string;
	/** The name before a rename. */
	beforeName?: string;
	/** The change's exact inverse, where it has one, as a Sheet's cells written. */
	undo?: FileUndo | null;
	/** What a version the change made holds, as a restore of a copy makes one: recorded at Drive's revision after it. */
	made?: Omit<RecordedContent, 'sourceRevision'>;
};

/** How a change is begun: one that changes what the file holds keeps a copy first; a rename or a move to Trash doesn't. */
export type ChangeScope = {content: boolean};

function copyMaxBytes(): number {
	return env.DRIVE_COPY_MAX_MB * 1024 * 1024;
}

// The largest size a version's row holds, a 32-bit number: a larger file's is left out.
const MAX_SIZE = 2_147_483_647;

/** A file's size as Drive writes it, as a number; null where Drive gives none, or past what a version's row holds. */
export function sizeOf(file: Pick<DriveFileState, 'size'>): number | null {
	const size = Number(file.size ?? Number.NaN);
	return Number.isSafeInteger(size) && size >= 0 && size <= MAX_SIZE ? size : null;
}

/**
 * Drive's revision of what a file holds now: an uploaded file's head revision, or the latest of a
 * Doc's, Sheet's or Slides file's revisions. Null for a folder, and for one of Google's types Drive
 * keeps no revisions of, as a form.
 */
export function revisionOf(token: string, file: DriveFileState): Promise<Result<string | null, ApiError>> {
	if (!isGoogleType(file.mimeType)) {
		return Promise.resolve(Ok(file.headRevisionId ?? null));
	}
	if (file.mimeType === MIME_TYPES.folder) {
		return Promise.resolve(Ok(null));
	}
	return Do(async ($) => {
		const listed = await latestRevision(token, file.id);
		if (listed.isErr() && listed.error.kind === 'validation_error') {
			return null;
		}
		return $(listed);
	});
}

// Whether a task has kept its copy of the file already; a member, who has no task, never has.
function hasCopied(change: FileChangeBy, fileId: string): Promise<Result<boolean, ApiError>> {
	if ('userId' in change.by) {
		return Promise.resolve(Ok(false));
	}
	return hasTaskCopied(change.connectionId, fileId, change.by.taskId);
}

function withoutBlob(version: FileVersionFound): FileVersionRow {
	const {blob: _blob, ...row} = version;
	return row;
}

// Bytes stored as a copy, up to the most a copy may be; none where they are more, or where Drive
// won't give them, as an export past its 10 MB. Google out of reach is passed on.
function storedCopy(orgId: string, bytes: Promise<Result<ReadableStream<Uint8Array>, ApiError>>): Promise<Result<StoredContent | null, ApiError>> {
	return Do(async ($) => {
		const stream = await bytes;
		if (stream.isErr() && stream.error.kind === 'validation_error') {
			return null;
		}
		const stored = await storeContent(orgId, $(stream), copyMaxBytes());
		if (stored.isErr() && stored.error.kind === 'validation_error') {
			return null;
		}
		return $(stored);
	});
}

// A Doc's, Sheet's or Slides file's copy: its export into the store where it can be, and Drive's
// revision with it, or the revision alone.
function copyGoogleFile(editor: DriveEditor, file: DriveFileState, revision: string): Promise<Result<RecordedContent, ApiError>> {
	return Do(async ($) => {
		const office = OFFICE_TYPES[file.mimeType];
		const pointer = {blobId: null, size: null, type: office ?? file.mimeType, sourceRevision: revision, sourceType: file.mimeType};
		if (office === undefined || (await blobBackend()) === null) {
			return pointer;
		}
		const stored = $(await storedCopy(editor.change.orgId, exportBytes(editor.token, file.id, office)));
		return stored === null ? pointer : {...pointer, blobId: stored.blobId, size: stored.size};
	});
}

// An uploaded file's copy: the bytes the latest version holds already, where they are the same;
// else its bytes into the store, up to the most a copy may be; else its revision, kept for good in
// Drive. Drive keeps at most 200 revisions of a file so: one it won't keep is only noted.
function copyUploadedFile(editor: DriveEditor, file: DriveFileState, revision: string, latest: FileVersionFound | null): Promise<Result<RecordedContent, ApiError>> {
	return Do(async ($) => {
		const size = sizeOf(file);
		const pointer = {blobId: null, size, type: file.mimeType, sourceRevision: revision, sourceType: null};
		if (latest?.blob && latest.blob.sha256 !== null && latest.blob.sha256 === file.sha256Checksum) {
			return {...pointer, blobId: latest.blob.id, size: latest.blob.size, type: latest.type};
		}
		const fits = size !== null && size <= copyMaxBytes();
		const stored = fits && (await blobBackend()) !== null ? $(await storedCopy(editor.change.orgId, downloadFile(editor.token, file.id))) : null;
		if (stored !== null) {
			return {...pointer, blobId: stored.blobId, size: stored.size};
		}
		const pinned = await keepRevision(editor.token, file.id, revision, true);
		if (pinned.isErr() && pinned.error.kind !== 'validation_error') {
			return $(pinned);
		}
		return {...pointer, pinned: pinned.isOk()};
	});
}

/**
 * The copy of a file at `revision`, kept as the file's next version, or the latest version where
 * it holds that revision already, kept as well as it would be: none for a file Drive has no
 * revision of, as a folder.
 */
function keepCopy(editor: DriveEditor, file: DriveFileState, revision: string | null): Promise<Result<FileVersionRow | null, ApiError>> {
	return Do(async ($) => {
		if (revision === null) {
			return null;
		}
		const {connectionId} = editor.change;
		const latest = $(await getLatestFileVersion(connectionId, file.id));
		const google = isGoogleType(file.mimeType);
		if (latest && latest.sourceRevision === revision && (google || latest.blobId !== null || latest.pinned)) {
			return withoutBlob(latest);
		}
		const content = google ? $(await copyGoogleFile(editor, file, revision)) : $(await copyUploadedFile(editor, file, revision, latest));
		return $(await recordFileVersion({connectionId, fileId: file.id, content}));
	});
}

/**
 * Begins a change to a file in Drive: reads its revision, and, for a change to what it holds,
 * keeps its copy where the task has none yet. What it answers is what `logDriveChange` logs the
 * change with once it is made.
 */
export function beginDriveChange(editor: DriveEditor, fileId: string, scope: ChangeScope): Promise<Result<DriveChange, ApiError>> {
	return Do(async ($) => {
		const file = $(await getFileState(editor.token, fileId));
		const beforeRevision = $(await revisionOf(editor.token, file));
		const copy = scope.content && !$(await hasCopied(editor.change, file.id)) ? $(await keepCopy(editor, file, beforeRevision)) : null;
		return {fileId: file.id, name: file.name, mimeType: file.mimeType, beforeRevision, beforeVersion: copy?.id ?? null};
	});
}

// A change made in Drive, logged: one that can't be is logged on the server instead, by its ids and
// what went wrong, never the file's name or what it holds, and answered as none. By then the change
// is made, so the write it follows is no less done, and refusing it would have an agent make it
// again: a row appended twice, a file written over twice.
async function logged(editor: DriveEditor, fileId: string, kind: FileChangeKind, logging: Promise<Result<FileChangeRow, ApiError>>): Promise<FileChangeRow | null> {
	const result = await logging;
	if (result.isOk()) {
		return result.value;
	}
	log.error('A change made in Google Drive could not be logged in its history', {connectionId: editor.change.connectionId, fileId, kind, errorKind: result.error.kind});
	return null;
}

function logChange(editor: DriveEditor, change: DriveChange, entry: DriveChangeEntry): Promise<Result<FileChangeRow, ApiError>> {
	return Do(async ($) => {
		const after = $(await getFileState(editor.token, change.fileId));
		const afterRevision = $(await revisionOf(editor.token, after));
		const made = entry.made && {...entry.made, sourceRevision: afterRevision};
		const entered = $(
			await logFileChange(editor.change, {
				fileId: change.fileId,
				name: entry.name ?? after.name,
				kind: entry.kind,
				beforeVersion: change.beforeVersion,
				beforeRevision: change.beforeRevision,
				afterRevision,
				beforeName: entry.beforeName ?? null,
				undo: entry.undo ?? null,
				...(made ? {made} : {}),
			}),
		);
		return entered.change;
	});
}

/**
 * Logs a change begun with `beginDriveChange` once it is made in Drive, with Drive's revision of
 * the file after it. It never fails what it follows: a change that can't be logged is logged on
 * the server instead, and answered as null.
 */
export function logDriveChange(editor: DriveEditor, change: DriveChange, entry: DriveChangeEntry): Promise<FileChangeRow | null> {
	return logged(editor, change.fileId, entry.kind, logChange(editor, change, entry));
}

/**
 * A write to one file in Drive, made in one call, through its history: begun, so the task's copy
 * is kept first where the write changes what the file holds, and refused where that fails; made by
 * `write`, which answers what it did and how to log it; and logged, as `logDriveChange` logs.
 */
export function changeDriveFile<T>(
	editor: DriveEditor,
	fileId: string,
	scope: ChangeScope,
	write: (change: DriveChange) => Promise<Result<{done: T; entry: DriveChangeEntry}, ApiError>>,
): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const change = $(await beginDriveChange(editor, fileId, scope));
		const {done, entry} = $(await write(change));
		await logDriveChange(editor, change, entry);
		return done;
	});
}

/** A write for `changeDriveFile` that is logged as `entry` whatever it answers. */
export async function loggedAs<T>(entry: DriveChangeEntry, write: Promise<Result<T, ApiError>>): Promise<Result<{done: T; entry: DriveChangeEntry}, ApiError>> {
	return (await write).map((done) => ({done, entry}));
}

function logCreate(editor: DriveEditor, made: {id: string}): Promise<Result<FileChangeRow, ApiError>> {
	return Do(async ($) => {
		const file = $(await getFileState(editor.token, made.id));
		const afterRevision = $(await revisionOf(editor.token, file));
		const entered = $(await logFileChange(editor.change, {fileId: file.id, name: file.name, kind: 'create', afterRevision}));
		return entered.change;
	});
}

/**
 * Logs a file made in Drive, folders and copies too, as made by whoever made it; what a task made
 * needs no copy before it changes it. As `logDriveChange`, it never fails the making of the file.
 */
export function logDriveCreate(editor: DriveEditor, made: {id: string}): Promise<FileChangeRow | null> {
	return logged(editor, made.id, 'create', logCreate(editor, made));
}

/** A refusal for a write that reaches Drive with no one to log it as, which every write path gives. */
export function requireEditor(token: string, change: FileChangeBy | null): Result<DriveEditor, ApiError> {
	if (change === null) {
		return Err(ApiErr.internalError(new Error('A write to Google Drive came with no one to log it as')));
	}
	return Ok({token, change});
}
