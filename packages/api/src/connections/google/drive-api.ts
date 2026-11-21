import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do} from '@proxy/utils';

import {googleRequest, googleSession, googleStream, googleText, googleTransfer, googleUpload, googleWrite, multipartRelated} from './google-client';

/**
 * The Drive v3 calls the `files` collection makes, and the reading of their answers. Every call
 * takes shared drives too. A document or a spreadsheet is made from Markdown or CSV with the
 * Google type it is to become, and Drive converts it. A file's bytes go up as they come, through a
 * resumable upload's session, as a copy given back and a blob put in Drive do.
 */

const DRIVE = 'https://www.googleapis.com/drive/v3';

const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const PAGE_SIZE = 50;

/** Drive's ids, as every id an agent sends is checked against before it reaches an address or a query. */
export const DRIVE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * A file's id, given as it is or in a link to it: `…/d/<id>/edit`, as Docs, Sheets, Slides and
 * Drive's own file links have it, or Drive's `?id=` links; null for anything else.
 */
export function fileIdOf(text: string): string | null {
	const trimmed = text.trim();
	if (DRIVE_ID.test(trimmed)) {
		return trimmed;
	}
	const url = URL.parse(trimmed);
	if (!url || url.protocol !== 'https:' || !/(^|\.)google\.com$/.test(url.hostname)) {
		return null;
	}
	const id = /\/d\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
	return id && DRIVE_ID.test(id) ? id : null;
}

export const MIME_TYPES = {
	folder: 'application/vnd.google-apps.folder',
	document: 'application/vnd.google-apps.document',
	spreadsheet: 'application/vnd.google-apps.spreadsheet',
	presentation: 'application/vnd.google-apps.presentation',
};

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink,parents,driveId';

const driveFileSchema = z.object({
	id: z.string(),
	name: z.string(),
	mimeType: z.string(),
	modifiedTime: z.string().optional(),
	// None in a shared drive, which owns its files.
	owners: z.array(z.object({displayName: z.string().optional(), emailAddress: z.string().optional()})).optional(),
	webViewLink: z.string().optional(),
	parents: z.array(z.string()).optional(),
	driveId: z.string().optional(),
});

export type DriveFile = z.infer<typeof driveFileSchema>;

const fileListSchema = z.object({files: z.array(driveFileSchema), nextPageToken: z.string().optional()});

/** A file's place in the tree: its name, the folder it is in, and the shared drive it is in. */
const fileParentsSchema = z.object({id: z.string(), name: z.string(), parents: z.array(z.string()).optional(), driveId: z.string().optional()});

export type FileParents = z.infer<typeof fileParentsSchema>;

const sharedDriveSchema = z.object({id: z.string(), name: z.string()});

export type SharedDrive = z.infer<typeof sharedDriveSchema>;

const driveListSchema = z.object({drives: z.array(sharedDriveSchema), nextPageToken: z.string().optional()});

export type Page<T> = {items: T[]; nextPage: string | null};

function driveUrl(path: string, params: Record<string, string>, base: string = DRIVE): URL {
	const url = new URL(`${base}${path}`);
	for (const [name, value] of Object.entries(params)) {
		url.searchParams.set(name, value);
	}
	return url;
}

/** A term in Drive's query language, quoted: a backslash and a quote escaped with a backslash. */
export function driveQuoted(term: string): string {
	return `'${term.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * One page of files matching `q`, from the page a previous one pointed at. `params` narrows the
 * list further, such as to one shared drive (`corpora`, `driveId`) or by an order (`orderBy`).
 */
export async function listFiles(accessToken: string, q: string, params: Record<string, string>, pageToken: string | null): Promise<Result<Page<DriveFile>, ApiError>> {
	const url = driveUrl('/files', {
		q,
		pageSize: String(PAGE_SIZE),
		fields: `nextPageToken,files(${FILE_FIELDS})`,
		supportsAllDrives: 'true',
		includeItemsFromAllDrives: 'true',
		...params,
		...(pageToken ? {pageToken} : {}),
	});
	const list = await googleRequest(accessToken, url, fileListSchema);
	return list.map(({files, nextPageToken}) => ({items: files, nextPage: nextPageToken ?? null}));
}

/** A file's metadata. */
export function getFile(accessToken: string, fileId: string): Promise<Result<DriveFile, ApiError>> {
	return googleRequest(accessToken, driveUrl(`/files/${fileId}`, {fields: FILE_FIELDS, supportsAllDrives: 'true'}), driveFileSchema);
}

/** Where a file is: only what walking up the tree needs. */
export function getFileParents(accessToken: string, fileId: string): Promise<Result<FileParents, ApiError>> {
	return googleRequest(accessToken, driveUrl(`/files/${fileId}`, {fields: 'id,name,parents,driveId', supportsAllDrives: 'true'}), fileParentsSchema);
}

/** The id of My Drive itself, which Drive calls `root` in queries but names by its own id in `parents`. */
export async function getMyDriveId(accessToken: string): Promise<Result<string, ApiError>> {
	const root = await googleRequest(accessToken, driveUrl('/files/root', {fields: 'id'}), z.object({id: z.string()}));
	return root.map(({id}) => id);
}

/** A Google document, spreadsheet or presentation exported as text, such as `text/markdown`. */
export function exportFile(accessToken: string, fileId: string, mimeType: string): Promise<Result<string, ApiError>> {
	return googleText(accessToken, driveUrl(`/files/${fileId}/export`, {mimeType}));
}

/** One page of the shared drives the account is a member of, those whose names contain `search` when given. */
export async function listSharedDrives(accessToken: string, search: string | null, pageToken: string | null): Promise<Result<Page<SharedDrive>, ApiError>> {
	const url = driveUrl('/drives', {pageSize: String(PAGE_SIZE), ...(search ? {q: `name contains ${driveQuoted(search)}`} : {}), ...(pageToken ? {pageToken} : {})});
	const list = await googleRequest(accessToken, url, driveListSchema);
	return list.map(({drives, nextPageToken}) => ({items: drives, nextPage: nextPageToken ?? null}));
}

export function getSharedDrive(accessToken: string, driveId: string): Promise<Result<SharedDrive, ApiError>> {
	return googleRequest(accessToken, driveUrl(`/drives/${driveId}`, {fields: 'id,name'}), sharedDriveSchema);
}

/** A new file's name, the type it is to be, and the folder it goes in. */
export type NewFile = {name: string; mimeType: string; parent: string};

/** What a file is uploaded as: its type, such as `text/markdown`, and its text. */
export type Upload = {type: string; body: string};

// Text uploaded as the UTF-8 it is sent as, so Drive reads letters beyond ASCII as they are.
function textType(type: string): string {
	return `${type}; charset=UTF-8`;
}

function metadataOf(file: NewFile): object {
	return {name: file.name, mimeType: file.mimeType, parents: [file.parent]};
}

const WRITE_PARAMS = {fields: FILE_FIELDS, supportsAllDrives: 'true'};

/** Makes a file in a folder: empty, or from what is uploaded, which Drive converts to the file's type. */
export function createFile(accessToken: string, file: NewFile, upload: Upload | null): Promise<Result<DriveFile, ApiError>> {
	if (upload === null) {
		return googleWrite(accessToken, 'POST', driveUrl('/files', WRITE_PARAMS), metadataOf(file), driveFileSchema);
	}
	return googleUpload(
		accessToken,
		'POST',
		driveUrl('/files', {...WRITE_PARAMS, uploadType: 'multipart'}, UPLOAD),
		multipartRelated(metadataOf(file), textType(upload.type), upload.body),
		driveFileSchema,
	);
}

/** A copy of a file, made by Drive itself, in the folder given under the name given. */
export function copyFile(accessToken: string, fileId: string, copy: {name: string; parent: string}): Promise<Result<DriveFile, ApiError>> {
	return googleWrite(accessToken, 'POST', driveUrl(`/files/${fileId}/copy`, WRITE_PARAMS), {name: copy.name, parents: [copy.parent]}, driveFileSchema);
}

/** Changes a file's metadata, such as its name, or puts it in Trash. */
export function updateFile(accessToken: string, fileId: string, changes: {name?: string; trashed?: true}): Promise<Result<DriveFile, ApiError>> {
	return googleWrite(accessToken, 'PATCH', driveUrl(`/files/${fileId}`, {fields: FILE_FIELDS, supportsAllDrives: 'true'}), changes, driveFileSchema);
}

// ---- What a file's history needs ---------------------------------------------------------------

/** The Office file each of Google's types converts to and from: a Doc docx, a Sheet xlsx, a Slides file pptx. */
export const OFFICE_TYPES: Partial<Record<string, string>> = {
	[MIME_TYPES.document]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	[MIME_TYPES.spreadsheet]: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	[MIME_TYPES.presentation]: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Whether a type is one of Google's own, a Doc, Sheet, Slides file, folder or other, which has no bytes of its own in Drive. */
export function isGoogleType(mimeType: string): boolean {
	return mimeType.startsWith('application/vnd.google-apps.');
}

const STATE_FIELDS = 'id,name,mimeType,webViewLink,parents,driveId,modifiedTime,headRevisionId,sha256Checksum,size,version';

// `headRevisionId` and `sha256Checksum` only for a file with bytes of its own, not one of Google's
// types; `size` and `version` as text, as Drive writes its 64-bit numbers. `version` goes up with
// every change to the file, its name too, which is how a Doc's, Sheet's or Slides file's is told.
const fileStateSchema = z.object({
	id: z.string(),
	name: z.string(),
	mimeType: z.string(),
	webViewLink: z.string().optional(),
	parents: z.array(z.string()).optional(),
	driveId: z.string().optional(),
	modifiedTime: z.string().optional(),
	headRevisionId: z.string().optional(),
	sha256Checksum: z.string().optional(),
	size: z.string().optional(),
	version: z.string().optional(),
});

/** A file as a change to it is recorded against: its revision, and what copying it needs. */
export type DriveFileState = z.infer<typeof fileStateSchema>;

/**
 * A file's version, as files_versions and pap files say it: a file with bytes of its own has its
 * head revision, which files_upload checks a write over it against; a Doc, Sheet or Slides file,
 * never written over, its version number. None for a folder.
 */
export function driveVersion(file: DriveFileState): string | null {
	if (file.mimeType === MIME_TYPES.folder) {
		return null;
	}
	return (isGoogleType(file.mimeType) ? file.version : file.headRevisionId) ?? null;
}

/** A file's metadata with its head revision, checksum and size. */
export function getFileState(accessToken: string, fileId: string): Promise<Result<DriveFileState, ApiError>> {
	return googleRequest(accessToken, driveUrl(`/files/${fileId}`, {fields: STATE_FIELDS, supportsAllDrives: 'true'}), fileStateSchema);
}

const fileStateListSchema = z.object({files: z.array(fileStateSchema), nextPageToken: z.string().optional()});

/**
 * One page of files matching `q`, each as `getFileState` reads one, with its version and size, as
 * `pap files` lists a folder and finds a file by its path in it. `params` narrows the list, as
 * `listFiles` takes them, and may ask for a larger page (`pageSize`, at most 1000).
 */
export async function listFileStates(accessToken: string, q: string, params: Record<string, string>, pageToken: string | null): Promise<Result<Page<DriveFileState>, ApiError>> {
	const url = driveUrl('/files', {
		q,
		pageSize: String(PAGE_SIZE),
		fields: `nextPageToken,files(${STATE_FIELDS})`,
		supportsAllDrives: 'true',
		includeItemsFromAllDrives: 'true',
		...params,
		...(pageToken ? {pageToken} : {}),
	});
	const list = await googleRequest(accessToken, url, fileStateListSchema);
	return list.map(({files, nextPageToken}) => ({items: files, nextPage: nextPageToken ?? null}));
}

const revisionListSchema = z.object({revisions: z.array(z.object({id: z.string()})).optional(), nextPageToken: z.string().optional()});

// How many pages of a file's revisions are read for its latest at most: Drive lists them oldest
// first, a thousand to a page.
const MAX_REVISION_PAGES = 20;

/**
 * A file's latest revision, as Drive's version history lists it, the last of its revisions: for a
 * Doc, Sheet or Slides file, which has no head revision of its own. Null where Drive lists none.
 */
export function latestRevision(accessToken: string, fileId: string): Promise<Result<string | null, ApiError>> {
	return Do(async ($) => {
		let latest: string | null = null;
		let pageToken: string | null = null;
		for (let page = 0; page < MAX_REVISION_PAGES; page += 1) {
			const url = driveUrl(`/files/${fileId}/revisions`, {fields: 'nextPageToken,revisions(id)', pageSize: '1000', ...(pageToken ? {pageToken} : {})});
			const list = $(await googleRequest(accessToken, url, revisionListSchema));
			latest = list.revisions?.at(-1)?.id ?? latest;
			if (!list.nextPageToken) {
				return latest;
			}
			pageToken = list.nextPageToken;
		}
		return latest;
	});
}

/** Marks a revision of a file with bytes of its own to be kept for good; Drive keeps at most 200 such a file. */
export async function keepRevision(accessToken: string, fileId: string, revisionId: string): Promise<Result<void, ApiError>> {
	const answer = await googleWrite(accessToken, 'PATCH', driveUrl(`/files/${fileId}/revisions/${revisionId}`, {fields: 'id,keepForever'}), {keepForever: true}, z.object({id: z.string()}));
	return answer.map(() => undefined);
}

/** A file's bytes, as they come, for a file that isn't one of Google's types. */
export function downloadFile(accessToken: string, fileId: string): Promise<Result<ReadableStream<Uint8Array>, ApiError>> {
	return googleStream(accessToken, driveUrl(`/files/${fileId}`, {alt: 'media', supportsAllDrives: 'true'}));
}

/** The bytes of one of a file's revisions, as they come, for a file that isn't one of Google's types. */
export function downloadRevision(accessToken: string, fileId: string, revisionId: string): Promise<Result<ReadableStream<Uint8Array>, ApiError>> {
	return googleStream(accessToken, driveUrl(`/files/${fileId}/revisions/${revisionId}`, {alt: 'media'}));
}

/** A Doc, Sheet or Slides file exported as `mimeType`, as its bytes come; Drive exports at most 10 MB. */
export function exportBytes(accessToken: string, fileId: string, mimeType: string): Promise<Result<ReadableStream<Uint8Array>, ApiError>> {
	return googleStream(accessToken, driveUrl(`/files/${fileId}/export`, {mimeType}));
}

/**
 * Opens a resumable upload of bytes of `type`, `size` of them where that is known, in place of all
 * of a file's content, as its new revision, keeping its id: a file with bytes of its own takes them
 * as they are; a Doc, Sheet or Slides file takes a docx, xlsx or pptx and converts it into what it
 * is. Answers the session's address, where the bytes go.
 */
export function openWriteSession(accessToken: string, fileId: string, content: {type: string; size: number | null}): Promise<Result<string, ApiError>> {
	const url = driveUrl(`/files/${fileId}`, {uploadType: 'resumable', fields: STATE_FIELDS, supportsAllDrives: 'true'}, UPLOAD);
	return googleSession(accessToken, 'PATCH', url, {...content, metadata: {}});
}

/**
 * Puts bytes in place of all of a file's content, as `openWriteSession` takes them, sent through
 * the session, as Drive takes a file of more than 5 MB, in one request as they come.
 */
export function putContent(accessToken: string, fileId: string, content: {type: string; body: ReadableStream<Uint8Array>; size: number | null}): Promise<Result<DriveFileState, ApiError>> {
	return Do(async ($) => {
		const session = $(await openWriteSession(accessToken, fileId, content));
		return $(await googleTransfer(accessToken, 'PUT', new URL(session), content, fileStateSchema));
	});
}

// ---- New files from bytes as they come -------------------------------------------------------------

/**
 * Makes a new file of bytes of `type`, `size` of them, in the folder given, as `file.mimeType`:
 * the bytes' own type keeps them as they are, and a Google type converts them, as a docx into a
 * Doc. Sent through a resumable session, as Drive takes a file of
 * more than 5 MB, in one request as they come.
 */
export function createContent(accessToken: string, file: NewFile, content: {type: string; body: ReadableStream<Uint8Array>; size: number}): Promise<Result<DriveFileState, ApiError>> {
	return Do(async ($) => {
		const url = driveUrl('/files', {uploadType: 'resumable', fields: STATE_FIELDS, supportsAllDrives: 'true'}, UPLOAD);
		const session = $(await googleSession(accessToken, 'POST', url, {type: content.type, size: content.size, metadata: metadataOf(file)}));
		return $(await googleTransfer(accessToken, 'PUT', new URL(session), content, fileStateSchema));
	});
}
