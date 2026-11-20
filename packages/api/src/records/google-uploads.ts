import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {FileBlobRow} from '@proxy/db/files';
import type {FileUploadRow} from '@proxy/db/file-uploads';

import {
	createContent,
	createFile,
	driveQuoted,
	driveVersion,
	fileIdOf,
	generateFileId,
	getFile,
	getFileState,
	isGoogleType,
	listFileStates,
	MIME_TYPES,
	OFFICE_TYPES,
	putContent,
	type DriveFileState,
} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {openContent} from '../native/files/content';
import {mediaType} from '../native/files/names';
import type {DeclaredFile, DriveUploads, UploadMade, UploadRun, UploadStarted, UploadTarget} from '../uploads/tickets';
import {type DriveFolder, folderNamed} from './google-files';
import {changeBy, changeDriveFile, type DriveEditor, logDriveCreate, loggedAs} from './google-history';

/**
 * Uploads into Google Drive (uploads/tickets.ts): the bytes come to Personal Agent Proxy's own URL
 * first, into a blob of the store, as every upload's do, and only done sends them on to Drive, so
 * nothing is in Drive before done, and an upload never finished, or whose bytes aren't what was
 * said, leaves nothing there.
 *
 * A new file is uploaded as its bytes, of their own type, into a folder, a shared drive or My
 * Drive (google-files.ts `folderNamed`), inside the folders a push to a path names that are
 * missing, made at done, under an id Drive reserves for it at the start, so a done
 * asked again after Drive made the file finds it rather than making it twice; with `convert`, a
 * docx or Markdown becomes a Doc, an xlsx or CSV a Sheet, and a pptx a Slides file, which Drive
 * makes under an id of its own, as it reserves none for them. Over a file that is there, only a
 * file with bytes of its own takes bytes: a Doc, Sheet or Slides file is never written over whole,
 * which would lose its comments, suggestions and whatever the bytes can't hold, and is edited in
 * place instead (google-docs.ts, google-slides.ts, google-sheets.ts, google-ranges.ts). A write is
 * checked against the version read, the file's head revision, at the start and again at done, just
 * before the bytes go, and is made through the file's history
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

const SPREADSHEET_PARENT = 'A spreadsheet holds tabs: upload the file into a folder';

const GOOGLE_TYPE_REFUSAL =
	'A file uploaded is its own bytes, of their own type, never one of Google’s: to make a Doc, Sheet or Slides file, upload a docx, xlsx or pptx, or Markdown or CSV, with convert';

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

/** The type of the bytes uploaded over a file, as said, else the file's own; refused for a folder and for Google's own types, which take no bytes over them. */
function bytesOver(file: DriveFileState, said: string | null): Result<string, ApiError> {
	if (file.mimeType === MIME_TYPES.folder) {
		return Err(ApiErr.validationError(`“${file.name}” is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it`));
	}
	if (isGoogleType(file.mimeType)) {
		return Err(googleOverRefusal(file));
	}
	const type = typeSaid(said) ?? file.mimeType;
	if (isGoogleType(type)) {
		return Err(ApiErr.validationError(GOOGLE_TYPE_REFUSAL));
	}
	return Ok(type);
}

// A new file: into a folder that is there, inside the folders to make in it at done, as its bytes
// or converted, under an id Drive reserves for it.
function startCreate(token: string, target: Extract<UploadTarget, {kind: 'create'}>, file: DeclaredFile): Promise<Result<UploadStarted, ApiError>> {
	return Do(async ($) => {
		if (target.folders.some((folder) => folder.trim() === '')) {
			return $(Err(ApiErr.validationError('A folder needs a name')));
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
		$(await folderNamed(token, target.parentId, SPREADSHEET_PARENT));
		// Drive takes a reserved id only for a file kept as its bytes, not one it converts.
		const id = target.convert ? null : $(await generateFileId(token));
		return {name: made.name, type, fileId: id};
	});
}

// Why a file's version moved on since it was read, and what to do.
function changedSince(file: DriveFileState, read: string): ApiError {
	const now = driveVersion(file);
	return ApiErr.conflict(
		`“${file.name}” changed since version ${read}: it is at ${now ?? 'none'} now. Look at it again, then upload what you make of it with the version files_versions says it is at.`,
	);
}

// Over a file that is there, of bytes it takes, at the version read.
function startWrite(token: string, target: Extract<UploadTarget, {kind: 'write'}>, file: DeclaredFile): Promise<Result<UploadStarted, ApiError>> {
	return Do(async ($) => {
		const fileId = $(requirePresent(fileIdOf(target.fileId), ApiErr.validationError('Say which file to write over as id: its id, as files_list gives it, or its link')));
		const state = $(await getFileState(token, fileId));
		const type = $(bytesOver(state, file.type));
		if (driveVersion(state) !== target.version) {
			return $(Err(changedSince(state, target.version)));
		}
		return {name: state.name, type, fileId: state.id};
	});
}

function requireFileId(upload: FileUploadRow): Result<string, ApiError> {
	return requirePresent(upload.fileId, broken(upload, 'file'));
}

function requireVersion(upload: FileUploadRow, file: DriveFileState): Result<string, ApiError> {
	return requirePresent(driveVersion(file), broken(upload, 'version in Drive'));
}

// The file a done before made under the id reserved for it, and couldn't say so; none where there
// is no such file, or no id was reserved, as for a file Drive converts.
function madeBefore(token: string, upload: FileUploadRow): Promise<Result<DriveFileState | null, ApiError>> {
	return Do(async ($) => {
		if (upload.fileId === null) {
			return null;
		}
		const there = await getFileState(token, upload.fileId);
		if (there.isErr() && there.error.kind === 'not_found') {
			return null;
		}
		return $(there);
	});
}

// The folder called `name` in `parent`: one there already, as a done before made, else made now,
// logged as the upload's agent's.
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

// A new file made of the blob, inside the upload's folders, made where they are missing, under the
// id reserved for it where there is one; found, where a done before made it already.
function finishCreate(editor: DriveEditor, upload: FileUploadRow, blob: FileBlobRow): Promise<Result<UploadMade, ApiError>> {
	return Do(async ($) => {
		const there = $(await madeBefore(editor.token, upload));
		if (there !== null) {
			return {fileId: there.id, version: $(requireVersion(upload, there))};
		}
		let folder = $(await folderNamed(editor.token, upload.parentId, SPREADSHEET_PARENT));
		for (const name of upload.folders) {
			folder = $(await folderIn(editor, folder, name));
		}
		const parent = folder.id;
		const mimeType = upload.convert ? $(requirePresent(CONVERTED[upload.type], broken(upload, 'kind to convert into'))) : upload.type;
		const body = $(await openContent(blob));
		const made = $(await createContent(editor.token, {id: upload.fileId, name: upload.name, mimeType, parent}, {type: upload.type, body, size: blob.size}));
		await logDriveCreate(editor, made);
		return {fileId: made.id, version: $(requireVersion(upload, made))};
	});
}

// The blob put in place of what the file holds, as its new revision, still at the version read.
function finishWrite(editor: DriveEditor, upload: FileUploadRow, blob: FileBlobRow): Promise<Result<UploadMade, ApiError>> {
	return Do(async ($) => {
		const state = $(await getFileState(editor.token, $(requireFileId(upload))));
		const read = $(requirePresent(upload.version, broken(upload, 'version read')));
		if (driveVersion(state) !== read) {
			return $(Err(changedSince(state, read)));
		}
		const written = $(
			await changeDriveFile(editor, state, {content: true}, () =>
				Do(async ($$) => {
					const body = $$(await openContent(blob));
					return $$(await loggedAs({kind: 'write'}, putContent(editor.token, state.id, {type: upload.type, body, size: blob.size})));
				}),
			),
		);
		return {fileId: written.id, version: $(requireVersion(upload, written))};
	});
}

export const googleUploads: DriveUploads = {
	start: (run, target, file) =>
		callGoogle(run.connection, (token) => {
			if (target.kind === 'create') {
				return startCreate(token, target, file);
			}
			return startWrite(token, target, file);
		}),

	finish: (run, upload, blob) =>
		callGoogle(run.connection, (token) => {
			const editor = uploaderOf(run, upload, token);
			if (upload.target === 'create') {
				return finishCreate(editor, upload, blob);
			}
			return finishWrite(editor, upload, blob);
		}),

	link: (run, _upload, made) =>
		callGoogle(run.connection, (token) =>
			Do(async ($) => {
				const file = $(await getFile(token, made.fileId));
				return file.webViewLink ?? `https://drive.google.com/open?id=${made.fileId}`;
			}),
		),
};
