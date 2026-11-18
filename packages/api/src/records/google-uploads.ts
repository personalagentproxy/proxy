import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getConnectionCredential} from '@proxy/db/connection';
import type {FileUploadRow} from '@proxy/db/file-uploads';

import {
	deleteRevision,
	driveVersion,
	fileIdOf,
	generateFileId,
	getFile,
	getFileState,
	isGoogleType,
	MIME_TYPES,
	OFFICE_TYPES,
	openCreateSession,
	openWriteSession,
	updateFile,
	type DriveFileState,
} from '../connections/google/drive-api';
import {callGoogle, googleSessionCancel, googleSessionStatus} from '../connections/google/google-client';
import {mediaType} from '../native/files/names';
import {log} from '../observability/log';
import {type DeclaredFile, type DriveUploads, UPLOAD_TTL_MS, type UploadArrived, type UploadRun, type UploadStarted, type UploadTarget} from '../uploads/tickets';
import {decryptSecret} from '../utils/secret-crypto';
import {folderNamed} from './google-files';
import {beginDriveChange, changeBy, type DriveChange, type DriveEditor, logDriveChange, logDriveCreate} from './google-history';

/**
 * Uploads into Google Drive (uploads/tickets.ts): the URL is Drive's own resumable upload session,
 * opened at the start with the connection's token, so the bytes go straight to Drive and never
 * through here; whoever has them sends them in one PUT, or in parts, as `pap files push` does. The
 * session's address is its own credential, kept encrypted on the upload and never logged. Past the
 * upload's hour, a session the bytes are still coming to is cancelled; one they are all in is kept
 * for done an hour more, as an upload here whose PUT ended in time is, and then what arrived is
 * taken back out of Drive, since only done makes a file.
 *
 * A new file is uploaded as its bytes, of their own type, under an id Drive reserves for it at the
 * start, into a folder, a shared drive or My Drive (google-files.ts `folderNamed`); with `convert`,
 * a docx or Markdown becomes a Doc, an xlsx or CSV a Sheet, and a pptx a Slides file. Over a file
 * that is there, a file with bytes of its own takes any bytes but Markdown or CSV, and a Doc, Sheet
 * or Slides file only the docx, xlsx or pptx Drive converts into it, so nothing it holds is lost to
 * a format that can't hold it. A write is checked against the version read, the head revision of a
 * file with bytes of its own or the version number of one of Google's, and the task's copy of the
 * file is kept before the session is opened (google-history.ts beginDriveChange), since Drive
 * writes the file as soon as the bytes are in.
 *
 * Done asks the session whether every byte is in, then compares Drive's size and SHA-256 of the
 * file with what was said: Drive keeps no bytes of a Doc, Sheet or Slides file, so what was
 * converted is taken as said. Bytes that aren't what was said are taken back out of Drive, a new
 * file moved to Trash and a revision written over a file deleted, so the one before is the file's
 * again. What was said is logged in the file's history as the agent's, for its task: a file made,
 * or a write with Drive's revisions before and after it.
 */

const MARKDOWN = 'text/markdown';
const CSV = 'text/csv';

// The kinds of Google's own file that take bytes, each only from the Office file Drive converts into it.
const GOOGLE_KINDS: Partial<Record<string, {name: string; from: string; instead: string}>> = {
	[MIME_TYPES.document]: {name: 'Doc', from: 'docx', instead: 'edit its text in place with docs_edit, upload a docx over it, or the Markdown as a new Doc, with name, parent and convert'},
	[MIME_TYPES.spreadsheet]: {name: 'Sheet', from: 'xlsx', instead: 'write its cells with ranges_write, or upload an xlsx over it'},
	[MIME_TYPES.presentation]: {name: 'Slides file', from: 'pptx', instead: 'replace its text in place with slides_edit, or upload a pptx over it'},
};

// What a new file's bytes become with convert, by their type.
const CONVERTED: Partial<Record<string, string>> = {
	...Object.fromEntries(Object.entries(OFFICE_TYPES).flatMap(([google, office]) => (office === undefined ? [] : [[office, google]]))),
	[MARKDOWN]: MIME_TYPES.document,
	[CSV]: MIME_TYPES.spreadsheet,
};

// The extensions of what is converted, which the file Drive makes of it goes without, as Drive's own import does.
const CONVERTED_EXTENSION = /\.(docx|xlsx|pptx|md|markdown|csv)$/i;

const GOOGLE_TYPE_REFUSAL =
	'A file uploaded is its own bytes, of their own type, never one of Google’s: to make a Doc, Sheet or Slides file, upload a docx, xlsx or pptx, or Markdown or CSV, with convert';

function editorOf(run: UploadRun, token: string): DriveEditor {
	return {token, change: changeBy(run.connection, {agentId: run.caller.agent.agentId, taskId: run.caller.taskId})};
}

// The upload's own agent and task, which done logs the file as, whoever finishes it.
function uploaderOf(run: UploadRun, upload: FileUploadRow, token: string): DriveEditor {
	return {token, change: changeBy(run.connection, {agentId: upload.agentId, taskId: upload.taskId})};
}

function broken(upload: FileUploadRow, what: string): ApiError {
	return ApiErr.internalError(new Error(`Upload ${upload.id} to Google Drive has no ${what}.`));
}

// The bytes' type as said, without its parameters; what the file's name says comes first for a new file.
function typeSaid(said: string | null): string | null {
	return said === null ? null : mediaType('', said, 'bytes');
}

// What a new file's bytes are made into with convert, and the name it goes by then.
function converted(name: string, type: string): Result<{name: string; mimeType: string}, ApiError> {
	const mimeType = CONVERTED[type];
	if (mimeType === undefined) {
		return Err(ApiErr.validationError(`convert makes a Doc of a docx or Markdown, a Sheet of an xlsx or CSV, and a Slides file of a pptx, and this is ${type}: leave convert out to keep it as it is`));
	}
	const bare = name.replace(CONVERTED_EXTENSION, '').trim();
	return Ok({name: bare === '' ? name : bare, mimeType});
}

// A new file: into a folder that is there, as its bytes or converted, under the id Drive reserves for it.
function startCreate(token: string, target: Extract<UploadTarget, {kind: 'create'}>, file: DeclaredFile): Promise<Result<UploadStarted, ApiError>> {
	return Do(async ($) => {
		if (target.folders.length > 0) {
			return $(Err(ApiErr.validationError('An upload into Google Drive goes into a folder that is there: make the folders first, with files_create')));
		}
		const given = target.name.trim();
		if (given === '') {
			return $(Err(ApiErr.validationError('A new file needs a name, with its extension, as report.pdf')));
		}
		const type = mediaType(given, file.type ?? undefined, 'bytes');
		if (isGoogleType(type)) {
			return $(Err(ApiErr.validationError(GOOGLE_TYPE_REFUSAL)));
		}
		const made = target.convert ? $(converted(given, type)) : {name: given, mimeType: type};
		const folderId = $(await folderNamed(token, target.parentId, 'A spreadsheet holds tabs: upload the file into a folder'));
		const id = $(await generateFileId(token));
		const url = $(await openCreateSession(token, {id, name: made.name, mimeType: made.mimeType, parent: folderId}, {type, size: file.size}));
		return {name: made.name, type, fileId: id, to: {kind: 'session' as const, url, resumable: true}, before: null};
	});
}

// Why Markdown or CSV is never uploaded over a file that is there, and what to do instead.
function textOverRefusal(file: DriveFileState, type: string): ApiError {
	const what = type === MARKDOWN ? 'Markdown' : 'CSV';
	const instead = GOOGLE_KINDS[file.mimeType]?.instead ?? 'upload it as a new file, with name and parent, instead';
	return ApiErr.validationError(
		`${what} is never uploaded over a file that is there, since a Doc or a Sheet would lose what it can’t hold, as its formatting and formulas. For “${file.name}”, ${instead}.`,
	);
}

/**
 * The type of the bytes uploaded over a file, as said, else the file's own, or for a Doc, Sheet or
 * Slides file the Office file it takes; refused where the file can't take them.
 */
function bytesOver(file: DriveFileState, said: string | null): Result<string, ApiError> {
	if (file.mimeType === MIME_TYPES.folder) {
		return Err(ApiErr.validationError(`“${file.name}” is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it`));
	}
	const kind = GOOGLE_KINDS[file.mimeType];
	const office = OFFICE_TYPES[file.mimeType];
	if (isGoogleType(file.mimeType) && (kind === undefined || office === undefined)) {
		return Err(ApiErr.validationError(`Drive takes no bytes over “${file.name}”, which is ${file.mimeType}`));
	}
	const type = typeSaid(said) ?? office ?? file.mimeType;
	if (type === MARKDOWN || type === CSV) {
		return Err(textOverRefusal(file, type));
	}
	if (kind !== undefined && type !== office) {
		return Err(ApiErr.validationError(`A ${kind.name} is written over only from a ${kind.from}, which Drive converts into it, and this is ${type}`));
	}
	if (isGoogleType(type)) {
		return Err(ApiErr.validationError(GOOGLE_TYPE_REFUSAL));
	}
	return Ok(type);
}

// Over a file that is there, at the version read: the task's copy kept first, as Drive writes the
// file once the bytes are in.
function startWrite(editor: DriveEditor, target: Extract<UploadTarget, {kind: 'write'}>, file: DeclaredFile): Promise<Result<UploadStarted, ApiError>> {
	return Do(async ($) => {
		const fileId = $(requirePresent(fileIdOf(target.fileId), ApiErr.validationError('Say which file to write over as id: its id, as files_list gives it, or its link')));
		const state = $(await getFileState(editor.token, fileId));
		const type = $(bytesOver(state, file.type));
		const version = driveVersion(state);
		if (version !== target.version) {
			return $(
				Err(
					ApiErr.conflict(
						`“${state.name}” changed since version ${target.version}: it is at ${version ?? 'none'} now. Look at it again, then upload what you make of it with the version files_versions says it is at.`,
					),
				),
			);
		}
		const change = $(await beginDriveChange(editor, state.id, {content: true}));
		const url = $(await openWriteSession(editor.token, state.id, {type, size: file.size}));
		return {name: state.name, type, fileId: state.id, to: {kind: 'session' as const, url, resumable: true}, before: {revision: change.beforeRevision, version: change.beforeVersion}};
	});
}

function requireFileId(upload: FileUploadRow): Result<string, ApiError> {
	return requirePresent(upload.fileId, broken(upload, 'file'));
}

// The session's address, kept encrypted on the upload.
function sessionOf(upload: FileUploadRow): Result<string, ApiError> {
	return Do<string, ApiError>(($) => $(decryptSecret($(requirePresent(upload.sessionUri, broken(upload, 'session'))))));
}

// What Drive has of an upload whose bytes are all in: the file's size and SHA-256, or, for what it
// converted into one of Google's types, which keep no bytes, what was said.
function measured(token: string, upload: FileUploadRow): Promise<Result<UploadArrived, ApiError>> {
	return Do(async ($) => {
		const file = $(await getFileState(token, $(requireFileId(upload))));
		if (isGoogleType(file.mimeType)) {
			return {size: upload.size, sha256: null};
		}
		const size = Number(file.size);
		return {size: Number.isSafeInteger(size) ? size : upload.size, sha256: file.sha256Checksum ?? null};
	});
}

/**
 * Takes what arrived for an upload back out of Drive, as only done makes a file: a new file made of
 * the bytes, nobody's file yet and never logged as made, moved to Trash; the revision they made
 * over a file deleted, only while it is still the head and holds them, so the one before is the
 * file's again. A Doc's, Sheet's or Slides file's revisions can't be deleted, so one written over
 * keeps what was converted into it, and the task's copy from the start is what gives it back.
 */
function takeBack(token: string, upload: FileUploadRow, arrived: UploadArrived): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const fileId = $(requireFileId(upload));
		const found = await getFileState(token, fileId);
		if (found.isErr() && found.error.kind === 'not_found') {
			return;
		}
		const file = $(found);
		if (upload.target === 'create') {
			$(await updateFile(token, fileId, {trashed: true}));
			return;
		}
		const head = file.headRevisionId;
		if (isGoogleType(file.mimeType) || head === undefined || head === upload.version || file.sha256Checksum !== arrived.sha256) {
			return;
		}
		$(await deleteRevision(token, fileId, head));
	});
}

// An upload whose bytes came in but that nobody finished in time, taken back out of Drive with the
// connection's token, as the sweep has no run to take it from. One that can't be, for good, as a
// connection signed out or a file no longer there, is let go all the same, and said in the log; one
// Google can't be reached for now is asked again at the next sweep.
function takeBackUnfinished(upload: FileUploadRow): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const credential = $(await getConnectionCredential(upload.connectionId));
		const taken = await callGoogle({id: upload.connectionId, credential}, (token) =>
			Do(async ($$) => {
				return $$(await takeBack(token, upload, $$(await measured(token, upload))));
			}),
		);
		if (taken.isErr() && taken.error.kind !== 'provider_unreachable') {
			log.warn('An unfinished upload’s bytes could not be taken back out of Google Drive', {uploadId: upload.id, kind: taken.error.kind});
			return;
		}
		$(taken);
	});
}

// The write as its history logs it, from what the start kept on the upload.
function changeOf(upload: FileUploadRow, file: DriveFileState): DriveChange {
	return {fileId: file.id, name: upload.name, mimeType: file.mimeType, beforeRevision: upload.beforeRevision, beforeVersion: upload.beforeVersion};
}

export const googleUploads: DriveUploads = {
	start: (run, target, file) =>
		callGoogle(run.connection, (token) => {
			if (target.kind === 'create') {
				return startCreate(token, target, file);
			}
			return startWrite(editorOf(run, token), target, file);
		}),

	arrived: (run, upload) =>
		callGoogle(run.connection, (token) =>
			Do(async ($) => {
				// Some of the bytes in, or none, or a session Drive no longer has: nothing is in the file yet.
				if ($(await googleSessionStatus($(sessionOf(upload)), upload.size)) !== 'complete') {
					return null;
				}
				return $(await measured(token, upload));
			}),
		),

	discard: (run, upload, arrived) => callGoogle(run.connection, (token) => takeBack(token, upload, arrived)),

	finish: (run, upload) =>
		callGoogle(run.connection, (token) =>
			Do(async ($) => {
				const file = $(await getFileState(token, $(requireFileId(upload))));
				const version = $(requirePresent(driveVersion(file), broken(upload, 'version in Drive')));
				const editor = uploaderOf(run, upload, token);
				if (upload.target === 'create') {
					await logDriveCreate(editor, file);
					return {fileId: file.id, version};
				}
				await logDriveChange(editor, changeOf(upload, file), {kind: 'write'});
				return {fileId: file.id, version};
			}),
		),

	link: (run, _upload, made) =>
		callGoogle(run.connection, (token) =>
			Do(async ($) => {
				const file = $(await getFile(token, made.fileId));
				return file.webViewLink ?? `https://drive.google.com/open?id=${made.fileId}`;
			}),
		),

	expire: (upload, now) =>
		Do(async ($) => {
			if (upload.sessionUri === null) {
				return 'let-go' as const;
			}
			const session = $(sessionOf(upload));
			const stands = $(await googleSessionStatus(session, upload.size));
			if (stands === 'gone') {
				return 'let-go' as const;
			}
			if (stands === 'open') {
				$(await googleSessionCancel(session));
				return 'let-go' as const;
			}
			if (now.getTime() < upload.expiresAt.getTime() + UPLOAD_TTL_MS) {
				return 'kept' as const;
			}
			$(await takeBackUnfinished(upload));
			return 'let-go' as const;
		}),
};
