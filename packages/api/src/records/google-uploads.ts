import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {
	createContent,
	createFile,
	driveQuoted,
	driveVersion,
	fileIdOf,
	getFileState,
	isGoogleType,
	listFileStates,
	MIME_TYPES,
	OFFICE_TYPES,
	putContent,
	type DriveFileState,
} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {type AgentBlob, type BlobFile, blobType} from '../blobs/blobs';
import {openContent} from '../native/files/content';
import type {DriveAt, UploadMade, UploadTarget} from '../native/files/drive';
import {mediaType} from '../native/files/names';
import {type DriveFolder, folderNamed} from './google-files';
import {changeBy, changeDriveFile, type DriveEditor, logDriveCreate, loggedAs} from './google-history';

/**
 * A blob put in Google Drive (native/files/drive.ts): the bytes go from the blob store to Drive as
 * they come, through a resumable session.
 *
 * A new file goes up as its bytes, of their own type, into a folder, a shared drive or My Drive
 * (google-files.ts `folderNamed`), inside the folders a push to a path names that are missing;
 * with `convert`, a docx or Markdown becomes a Doc, an xlsx or CSV a Sheet, and a pptx a Slides
 * file. Over a file that is there, only a file with bytes of its own takes bytes: a Doc, Sheet or
 * Slides file is never written over whole, which would lose its comments, suggestions and whatever
 * the bytes can't hold, and is edited in place instead (google-docs.ts, google-slides.ts,
 * google-sheets.ts, google-ranges.ts). A write is checked against the version read, the file's
 * head revision, just before the bytes go, and is made through the file's history
 * (google-history.ts `changeDriveFile`), which keeps the task's copy first and logs the write as
 * the agent's, for its task, with Drive's revisions before and after it.
 */

export const MARKDOWN = 'text/markdown';
export const CSV = 'text/csv';

/** The kinds of Google's own file, and how each is changed instead of written over, with which tools. */
export const GOOGLE_KINDS: Partial<Record<string, {name: string; instead: string}>> = {
	[MIME_TYPES.document]: {name: 'Doc', instead: 'edit its text in place with the docs_edit tool'},
	[MIME_TYPES.spreadsheet]: {name: 'Sheet', instead: 'write its cells with the ranges_write tool, and change its rows, columns and tabs with sheets_rows and sheets_tabs'},
	[MIME_TYPES.presentation]: {name: 'Slides file', instead: 'replace its text in place with the slides_edit tool'},
};

// What a new file's bytes become with convert, by their type.
const CONVERTED: Partial<Record<string, string>> = {
	...Object.fromEntries(Object.entries(OFFICE_TYPES).flatMap(([google, office]) => (office === undefined ? [] : [[office, google]]))),
	[MARKDOWN]: MIME_TYPES.document,
	[CSV]: MIME_TYPES.spreadsheet,
};

/** The extensions of what is converted, which the file Drive makes of it goes without, as Drive's own import does. */
export const CONVERTED_EXTENSION = /\.(docx|xlsx|pptx|md|markdown|csv)$/i;

const BYTES = 'application/octet-stream';

const SPREADSHEET_PARENT = 'A spreadsheet holds tabs: upload the file into a folder';

const GOOGLE_TYPE_REFUSAL =
	'A file uploaded is its own bytes, of their own type, never one of Google’s: to make a Doc, Sheet or Slides file, upload a docx, xlsx or pptx, or Markdown or CSV, with convert';

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

// Why a Doc, Sheet or Slides file is never uploaded over, and what to do instead.
function googleOverRefusal(file: DriveFileState): ApiError {
	const kind = GOOGLE_KINDS[file.mimeType];
	if (kind === undefined) {
		return ApiErr.validationError(`Drive takes no bytes over “${file.name}”, which is ${file.mimeType}`);
	}
	return ApiErr.validationError(
		`“${file.name}” is a ${kind.name}, which is never written over whole, since it would lose its comments, suggestions and formatting: ${kind.instead}, or upload the file as a new ${kind.name}, with name, parent and convert.`,
	);
}

/** The type of the bytes put over a file, as the blob says, else the file's own; refused for a folder and for Google's own types, which take no bytes over them. */
function bytesOver(file: DriveFileState, said: string | null): Result<string, ApiError> {
	if (file.mimeType === MIME_TYPES.folder) {
		return Err(ApiErr.validationError(`“${file.name}” is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it`));
	}
	if (isGoogleType(file.mimeType)) {
		return Err(googleOverRefusal(file));
	}
	// A blob that says nothing more of itself than that it is bytes keeps the file's own type.
	const typed = typeSaid(said);
	const type = typed === null || typed === BYTES ? file.mimeType : typed;
	if (isGoogleType(type)) {
		return Err(ApiErr.validationError(GOOGLE_TYPE_REFUSAL));
	}
	return Ok(type);
}

// Why a file's version moved on since it was read, and what to do.
function changedSince(file: DriveFileState, read: string): ApiError {
	const now = driveVersion(file);
	return ApiErr.conflict(
		`“${file.name}” changed since version ${read}: it is at ${now ?? 'none'} now. Look at it again, then put what you make of it in Drive with the version files_versions says it is at.`,
	);
}

// The folder called `name` in `parent`: one there already, else made now, logged as the agent's.
function folderIn(editor: DriveEditor, parent: DriveFolder, name: string): Promise<Result<DriveFolder, ApiError>> {
	return Do(async ($) => {
		const q = `${driveQuoted(parent.id)} in parents and name = ${driveQuoted(name)} and trashed = false`;
		const params: Record<string, string> = parent.driveId === null ? {pageSize: '10'} : {corpora: 'drive', driveId: parent.driveId, pageSize: '10'};
		const listed = $(await listFileStates(editor.token, q, params, null));
		const found = listed.items.find((file) => file.mimeType === MIME_TYPES.folder && file.name === name);
		if (found !== undefined) {
			return {id: found.id, driveId: parent.driveId};
		}
		const made = $(await createFile(editor.token, {name, mimeType: MIME_TYPES.folder, parent: parent.id}, null));
		await logDriveCreate(editor, made);
		return {id: made.id, driveId: parent.driveId};
	});
}

// The version Drive says a file it just made or wrote is at.
function versionOf(file: DriveFileState): Result<string, ApiError> {
	return requirePresent(driveVersion(file), ApiErr.providerUnreachable(new Error(`Google Drive said no version of “${file.name}”`)));
}

function madeOf(file: DriveFileState): Result<UploadMade, ApiError> {
	return versionOf(file).map((version) => ({fileId: file.id, name: file.name, version, link: file.webViewLink ?? `https://drive.google.com/open?id=${file.id}`}));
}

// What a new file of a blob is to be, checked before any bytes move: its name and its bytes' type,
// what Drive makes of them, as they are or converted, and the folder that is there for it.
type NewDriveFile = {name: string; type: string; mimeType: string; folder: DriveFolder};

function newFile(token: string, target: Extract<UploadTarget, {kind: 'create'}>, file: BlobFile): Promise<Result<NewDriveFile, ApiError>> {
	return Do(async ($) => {
		if (target.folders.some((folder) => folder.trim() === '')) {
			return $(Err(ApiErr.validationError('A folder needs a name')));
		}
		const given = target.name.trim();
		if (given === '') {
			return $(Err(ApiErr.validationError('A new file needs a name, with its extension, as report.pdf')));
		}
		const named = blobType(file, given);
		// A file to convert may be named without the extension that says what it is, as a push names
		// the Doc it becomes: then the blob's own name says, as notes.txt.md is Markdown, not text.
		const own = blobType(file, file.name ?? '');
		const type = target.convert && CONVERTED[named] === undefined && CONVERTED[own] !== undefined ? own : named;
		if (isGoogleType(type)) {
			return $(Err(ApiErr.validationError(GOOGLE_TYPE_REFUSAL)));
		}
		const made = target.convert ? $(converted(given, type)) : {name: given, mimeType: type};
		const folder = $(await folderNamed(token, target.parentId, SPREADSHEET_PARENT));
		return {name: made.name, type, mimeType: made.mimeType, folder};
	});
}

// The file a blob goes over, checked before any bytes move: one that takes bytes, of the type the
// blob's are, still at the version read.
function fileOver(token: string, target: Extract<UploadTarget, {kind: 'write'}>, file: BlobFile): Promise<Result<{state: DriveFileState; type: string}, ApiError>> {
	return Do(async ($) => {
		const fileId = $(requirePresent(fileIdOf(target.fileId), ApiErr.validationError('Say which file to write over as id: its id, as files_list gives it, or its link')));
		const state = $(await getFileState(token, fileId));
		const type = $(bytesOver(state, file.type));
		if (driveVersion(state) !== target.version) {
			return $(Err(changedSince(state, target.version)));
		}
		return {state, type};
	});
}

// A new file of the blob: into a folder that is there, inside the folders to make in it, as its
// bytes or converted.
function create(editor: DriveEditor, target: Extract<UploadTarget, {kind: 'create'}>, blob: AgentBlob): Promise<Result<UploadMade, ApiError>> {
	return Do(async ($) => {
		const made = $(await newFile(editor.token, target, blob));
		// The bytes are opened before any folder is made, so a store that can't give them leaves none behind.
		const body = $(await openContent(blob));
		let {folder} = made;
		for (const name of target.folders) {
			folder = $(await folderIn(editor, folder, name));
		}
		const file = $(await createContent(editor.token, {name: made.name, mimeType: made.mimeType, parent: folder.id}, {type: made.type, body, size: blob.size}));
		await logDriveCreate(editor, file);
		return $(madeOf(file));
	});
}

// The blob put in place of what a file holds, as its new revision, still at the version read.
function write(editor: DriveEditor, target: Extract<UploadTarget, {kind: 'write'}>, blob: AgentBlob): Promise<Result<UploadMade, ApiError>> {
	return Do(async ($) => {
		const {state, type} = $(await fileOver(editor.token, target, blob));
		const written = $(
			await changeDriveFile(editor, state, {content: true}, () =>
				Do(async ($$) => {
					const body = $$(await openContent(blob));
					return $$(await loggedAs({kind: 'write'}, putContent(editor.token, state.id, {type, body, size: blob.size})));
				}),
			),
		);
		return $(madeOf(written));
	});
}

/**
 * What putting a file in Google Drive would be refused for, checked before its bytes are sent, as
 * `uploadToDrive` checks it again once they are a blob: nothing is made, in Drive or in its history.
 */
export function checkDriveUpload(at: DriveAt, target: UploadTarget, file: BlobFile): Promise<Result<void, ApiError>> {
	return callGoogle(at.connection, (token) =>
		Do(async ($) => {
			if (target.kind === 'create') {
				$(await newFile(token, target, file));
				return;
			}
			$(await fileOver(token, target, file));
		}),
	);
}

/** Puts a blob in Google Drive, as the agent's, for its task: a new file, or a file's next version. */
export function uploadToDrive(at: DriveAt, target: UploadTarget, blob: AgentBlob): Promise<Result<UploadMade, ApiError>> {
	return callGoogle(at.connection, (token) => {
		const editor: DriveEditor = {token, change: changeBy(at.connection, {agentId: at.caller.agent.agentId, taskId: at.caller.taskId})};
		if (target.kind === 'create') {
			return create(editor, target, blob);
		}
		return write(editor, target, blob);
	});
}
