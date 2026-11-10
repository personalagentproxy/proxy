import {once} from 'node:events';

import type {Response} from 'express';
import {Err, Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {FILES_INTEGRATION_ID} from '@proxy/integrations';
import {
	contentQuerySchema,
	createFolderBodySchema,
	type DriveFile,
	type fileAnswerSchema,
	type FileCrumb,
	type fileDetailSchema,
	type fileListSchema,
	type FileVersion,
	listFilesQuerySchema,
	moveFileBodySchema,
	restoreFileBodySchema,
	uploadQuerySchema,
	writeQuerySchema,
} from '@proxy/contracts/files';
import {
	createFile,
	createFolder,
	type FileChangeBy,
	type FileEntry,
	type FileNodeRow,
	type FileVersionEntry,
	getFile,
	getFileVersion,
	listFileVersions,
	listFolder,
	listTrash,
	moveFile,
	restoreFileVersion,
	searchFiles,
	trashFile,
	untrashFile,
	writeFile,
} from '@proxy/db/files';

import {log, serializeError} from '../../observability/log';
import {loadConnection} from '../../records/target';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {sendApiError} from '../../server/response';
import {requireViewer} from '../../utils/user-org';
import {requireFile} from './connector';
import {maxFileBytes, openContent, storeContent, uploadBody} from './content';
import {isShownImage, mediaType, requireFileName} from './names';

/**
 * A drive as the person reads and changes it, on its connection's page: listing and searching its
 * folders, the trash, a file with its versions, and what a person does to one: uploading it or a
 * new version of it, making a folder, renaming and moving, the trash and back, and giving an
 * earlier version back. Everything a member who uses the connection may do, unlogged as the
 * person's own doings are, but written in the drive's journal as theirs, beside what their agents
 * did (db/files.ts). Bytes are streamed both ways, never held whole: an upload's body is the file
 * itself, and a download is sent so that nothing in it runs in the app's origin: as a file to
 * save, but for the pictures a browser shows as they are.
 */

type Drive = {connectionId: string; change: FileChangeBy};

// The drive the address names, among the connections the person uses, and who they are.
function driveOf(request: AuthenticatedRequest): Promise<Result<Drive, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const {connection, integration} = $(await loadConnection(viewer, connectionId));
		if (integration.id !== FILES_INTEGRATION_ID) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
		return {connectionId: connection.id, change: {orgId: connection.orgId, connectionId: connection.id, by: {userId: viewer.userId}}};
	});
}

// A file or a folder as a list shows it; with `above`, the folders it is in, said too, as for what
// a search found or the trash holds.
function toFile(entry: FileEntry, above?: FileNodeRow[]): DriveFile {
	return {
		id: entry.id,
		name: entry.name,
		folder: entry.folder,
		parentId: entry.parentId,
		path: above === undefined ? null : above.map((folder) => folder.name).join(' / '),
		version: entry.head?.id ?? null,
		type: entry.head?.type ?? null,
		size: entry.head?.size ?? null,
		shown: entry.head !== null && isShownImage(entry.head.type),
		modifiedAt: entry.updatedAt.toISOString(),
		trashedAt: entry.trashedAt?.toISOString() ?? null,
	};
}

function toCrumbs(trail: FileNodeRow[]): FileCrumb[] {
	return trail.map((folder) => ({id: folder.id, name: folder.name}));
}

function toVersion(version: FileVersionEntry, headId: string | null): FileVersion {
	const {author} = version;
	const by = (): FileVersion['by'] => {
		if (author === null) {
			return null;
		}
		if (author.user !== null) {
			return {kind: 'person', name: author.user.name ?? author.user.email, task: null};
		}
		return {kind: 'agent', name: author.personaName ?? author.agent?.name ?? 'An agent', task: author.task};
	};
	return {id: version.id, size: version.size, type: version.type, at: version.createdAt.toISOString(), current: version.id === headId, by: by(), restored: author?.kind === 'restore'};
}

/** `GET files`: what a folder holds, or what a search by name finds, with the folders down to it. */
export function handleListFilesRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileListSchema>, ApiError>> {
	return Do(async ($) => {
		const {connectionId} = $(await driveOf(request));
		const {parent, search} = $(parseSchema(listFilesQuerySchema, request.query));
		const folder = parent === undefined ? null : $(await requireFile(connectionId, parent));
		if (folder !== null && !folder.folder) {
			return $(Err(ApiErr.validationError(`${folder.name} is a file, not a folder`)));
		}
		const trail = folder === null ? [] : toCrumbs([...folder.trail, folder]);
		const words = search?.trim();
		if (words) {
			const found = $(await searchFiles(connectionId, words, folder?.id ?? null));
			return {files: found.map((entry) => toFile(entry, entry.trail)), trail};
		}
		return {files: $(await listFolder(connectionId, folder?.id ?? null)).map((entry) => toFile(entry)), trail};
	});
}

/** `GET files/trash`: what is in the trash, last trashed first. */
export function handleListTrashRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileListSchema>, ApiError>> {
	return Do(async ($) => {
		const {connectionId} = $(await driveOf(request));
		return {files: $(await listTrash(connectionId)).map((entry) => toFile(entry, entry.trail)), trail: []};
	});
}

/** `GET files/:fileId`: a file or a folder, in the trash or not, with where it is and a file's versions. */
export function handleGetFileRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileDetailSchema>, ApiError>> {
	return Do(async ($) => {
		const {connectionId} = $(await driveOf(request));
		const fileId = request.params.fileId ?? '';
		const file = $(requirePresent($(await getFile(connectionId, fileId)), ApiErr.notFound('file', fileId)));
		const versions = file.folder ? [] : $(await listFileVersions(connectionId, file.id));
		return {file: toFile(file), trail: toCrumbs(file.trail), versions: versions.map((version) => toVersion(version, file.head?.id ?? null))};
	});
}

/** `POST files/folders`: a new folder. */
export function handleCreateFolderRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const {change} = $(await driveOf(request));
		const {name, parent} = $(parseSchema(createFolderBodySchema, request.body));
		const made = $(await createFolder(change, {parentId: parent, name: $(requireFileName(name))}));
		return {file: toFile({...made, head: null})};
	});
}

/** `POST files/uploads`: a new file from the request's body, called a free name where its own is taken. */
export function handleUploadFileRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const {change, connectionId} = $(await driveOf(request));
		const {name: raw, parent = null, type} = $(parseSchema(uploadQuerySchema, request.query));
		const name = $(requireFileName(raw));
		// Before the bytes are taken, so an upload into a folder that isn't there stores nothing.
		if (parent !== null) {
			$(await requireFile(connectionId, parent));
		}
		const stored = $(await storeContent(change.orgId, $(uploadBody(request)), maxFileBytes()));
		const made = $(await createFile(change, {parentId: parent, name, rename: true, content: {blobId: stored.blobId, size: stored.size, type: mediaType(name, type, 'bytes')}}));
		return {file: toFile(made)};
	});
}

/** `PUT files/:fileId/content`: a file's next version from the request's body, by whoever saw the one it holds. */
export function handleWriteFileRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const {change, connectionId} = $(await driveOf(request));
		const {version, type} = $(parseSchema(writeQuerySchema, request.query));
		const file = $(await requireFile(connectionId, request.params.fileId ?? ''));
		if (file.head?.id !== version) {
			return $(Err(ApiErr.conflict(`${file.name} changed since this page showed it. Open it again, then upload.`)));
		}
		const stored = $(await storeContent(change.orgId, $(uploadBody(request)), maxFileBytes()));
		const written = $(await writeFile(change, {fileId: file.id, ifVersion: version, content: {blobId: stored.blobId, size: stored.size, type: mediaType(file.name, type, 'bytes')}}));
		return {file: toFile(written)};
	});
}

/** `PATCH files/:fileId`: renamed, moved, or both. */
export function handleMoveFileRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const {change, connectionId} = $(await driveOf(request));
		const {name, parent} = $(parseSchema(moveFileBodySchema, request.body));
		const moved = $(await moveFile(change, {id: request.params.fileId ?? '', name: name === undefined ? undefined : $(requireFileName(name)), ...(parent === undefined ? {} : {parentId: parent})}));
		return {file: toFile($(await requireFile(connectionId, moved.id)))};
	});
}

/** `POST files/:fileId/trash`: into the trash. */
export function handleTrashFileRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {change} = $(await driveOf(request));
		$(await trashFile(change, request.params.fileId ?? ''));
	});
}

/** `POST files/:fileId/untrash`: out of the trash, back where it was. */
export function handleUntrashFileRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const {change, connectionId} = $(await driveOf(request));
		const back = $(await untrashFile(change, request.params.fileId ?? ''));
		return {file: toFile($(await requireFile(connectionId, back.id)))};
	});
}

/** `POST files/:fileId/restore`: an earlier version given back, as the file's next. */
export function handleRestoreFileRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof fileAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const {change} = $(await driveOf(request));
		const {version} = $(parseSchema(restoreFileBodySchema, request.body));
		return {file: toFile($(await restoreFileVersion(change, {fileId: request.params.fileId ?? '', versionId: version})))};
	});
}

// A file's name as a download's header carries it: plain where it is, and in full beside it.
function disposition(name: string, inline: boolean): string {
	const plain = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `${inline ? 'inline' : 'attachment'}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

type Download = {name: string; type: string; size: number; body: ReadableStream<Uint8Array>};

function downloadOf(request: AuthenticatedRequest): Promise<Result<Download, ApiError>> {
	return Do(async ($) => {
		const {connectionId} = $(await driveOf(request));
		const fileId = request.params.fileId ?? '';
		const {version: asked} = $(parseSchema(contentQuerySchema, request.query));
		// One in the trash is still read, by whoever looks at the trash.
		const file = $(requirePresent($(await getFile(connectionId, fileId)), ApiErr.notFound('file', fileId)));
		const versionId = $(requirePresent(asked ?? file.head?.id, ApiErr.notFound('file', fileId)));
		const version = $(requirePresent($(await getFileVersion(connectionId, file.id, versionId)), ApiErr.notFound('version', versionId)));
		return {name: file.name, type: version.type, size: version.size, body: $(await openContent(version.blob))};
	});
}

/**
 * `GET files/:fileId/content`: the bytes of what the file holds, or of a version of it. Sent to
 * be saved, with its name, but for a picture a browser shows as it is, which is sent to be shown;
 * either way as its own type, never sniffed for another, and with a policy under which nothing in
 * it runs, loads or posts, so a file someone uploaded is never a page of the app's.
 */
export async function handleFileContentRoute(request: AuthenticatedRequest, response: Response): Promise<void> {
	const download = await downloadOf(request);
	if (download.isErr()) {
		sendApiError(response, download.error);
		return;
	}
	const {name, type, size, body} = download.value;
	response.status(200);
	response.setHeader('Content-Type', type);
	response.setHeader('Content-Length', String(size));
	response.setHeader('Content-Disposition', disposition(name, isShownImage(type)));
	response.setHeader('X-Content-Type-Options', 'nosniff');
	response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
	response.setHeader('Cache-Control', 'private, no-cache');
	const sent = await Result.wrapAsync(async () => {
		for await (const chunk of body) {
			if (!response.write(chunk)) {
				await once(response, 'drain');
			}
		}
	});
	if (sent.isErr()) {
		// The headers are sent: the connection is ended short, which a browser takes as a failed download.
		log.warn('A file’s download failed partway', {fileName: name, ...serializeError(sent.error)});
		response.destroy();
		return;
	}
	response.end();
}
