import {randomUUID} from 'node:crypto';

import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest, googleText, googleUpload, googleWrite} from './google-client';

/**
 * The Drive v3 calls the `files` collection makes, and the reading of their answers. Every call
 * takes shared drives too. A document or a spreadsheet is uploaded as Markdown or CSV with the
 * Google type it is to become, and Drive converts it; any other file is uploaded as its bytes, with
 * its own type, and kept as it is.
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

// A file's metadata and its content, text or bytes, in one request, as Drive's multipart upload
// takes them.
function multipart(metadata: object, type: string, content: string | Uint8Array<ArrayBuffer>): {type: string; body: Blob} {
	const boundary = `proxy-${randomUUID()}`;
	const head = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata), `--${boundary}`, `Content-Type: ${type}`, '', ''].join('\r\n');
	return {type: `multipart/related; boundary=${boundary}`, body: new Blob([head, content, `\r\n--${boundary}--`])};
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
	return googleUpload(accessToken, 'POST', driveUrl('/files', {...WRITE_PARAMS, uploadType: 'multipart'}, UPLOAD), multipart(metadataOf(file), textType(upload.type), upload.body), driveFileSchema);
}

/** Uploads a file's bytes as they are, of the type it is made as, which is never one of Google's own, so nothing is converted. */
export function uploadFile(accessToken: string, file: NewFile, bytes: Uint8Array<ArrayBuffer>): Promise<Result<DriveFile, ApiError>> {
	return googleUpload(accessToken, 'POST', driveUrl('/files', {...WRITE_PARAMS, uploadType: 'multipart'}, UPLOAD), multipart(metadataOf(file), file.mimeType, bytes), driveFileSchema);
}

/** A copy of a file, made by Drive itself, in the folder given under the name given. */
export function copyFile(accessToken: string, fileId: string, copy: {name: string; parent: string}): Promise<Result<DriveFile, ApiError>> {
	return googleWrite(accessToken, 'POST', driveUrl(`/files/${fileId}/copy`, WRITE_PARAMS), {name: copy.name, parents: [copy.parent]}, driveFileSchema);
}

/** Changes a file's metadata, such as its name, or puts it in Trash. */
export function updateFile(accessToken: string, fileId: string, changes: {name?: string; trashed?: true}): Promise<Result<DriveFile, ApiError>> {
	return googleWrite(accessToken, 'PATCH', driveUrl(`/files/${fileId}`, {fields: FILE_FIELDS, supportsAllDrives: 'true'}), changes, driveFileSchema);
}

/** Replaces all of a file's content with what is uploaded, which Drive converts to the file's own type. */
export function replaceContent(accessToken: string, fileId: string, upload: Upload): Promise<Result<DriveFile, ApiError>> {
	return googleUpload(
		accessToken,
		'PATCH',
		driveUrl(`/files/${fileId}`, {uploadType: 'media', fields: FILE_FIELDS, supportsAllDrives: 'true'}, UPLOAD),
		{...upload, type: textType(upload.type)},
		driveFileSchema,
	);
}
