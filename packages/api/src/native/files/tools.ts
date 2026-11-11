import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {
	createFile,
	createFolder,
	type FileChangeBy,
	type FileEntry,
	type FileFound,
	getFile,
	getFileVersion,
	listFileVersions,
	moveFile,
	restoreFileVersion,
	trashFile,
	untrashFile,
	type VersionAuthor,
	writeFile,
} from '@proxy/db/files';

import type {NativeToolRun, NativeToolRunner} from '../tool';
import {requireFile} from './connector';
import {maxFileBytes, storeText} from './content';
import {fileLink} from './links';
import {mediaType, requireFileName} from './names';
import {describeUnread, pathOf, readVersion, stretch} from './text';

/**
 * The Files tools of the integration's own: every write to a drive, and the reads that name a
 * version. Each change is made as the agent, for the task the call is run for, which the journal
 * keeps beside it (db/files.ts), so what an agent did to a file can be told from what the person
 * did, and given back. Content comes and goes as text: a new file's and a write's are stored as
 * UTF-8, whatever the file is called. An answer is a few lines a model reads, a file's id and
 * the version it holds among them, since the next write has to name it, and its link, the page
 * the person opens it on.
 */

function changeOf({caller, connection}: NativeToolRun): FileChangeBy {
	return {orgId: connection.orgId, connectionId: connection.id, by: {agentId: caller.agent.agentId, taskId: caller.taskId}};
}

// A tool's params read against its schema; what is wrong is said with the tool's own params named.
function read<T>(schema: z.ZodType<T>, tool: string, takes: string, params: Record<string, unknown>): Result<T, ApiError> {
	return parseSchema(schema, params).mapErr((error) => ApiErr.validationError(`${tool} takes ${takes}${error.kind === 'parse_error' ? `: ${error.message}` : ''}`));
}

// A file as a write answers it: what the next call on it needs.
function described(run: NativeToolRun, entry: FileEntry, said: string): string {
	const lines = [said, `Id: ${entry.id}`];
	if (entry.head !== null) {
		lines.push(`Version: ${entry.head.id}`, `Size: ${formatBytes(entry.head.size)}`);
	}
	lines.push(`Link: ${fileLink(run.caller.agent.orgSlug, run.connection.id, entry)}`);
	return lines.join('\n');
}

const createSchema = z.object({name: z.string(), parent: z.string().min(1).optional(), content: z.string().optional(), folder: z.boolean().optional()});

/** `files_create`: a new file holding the text given, or a folder. */
export const runFilesCreate: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {name: raw, parent = null, content, folder = false} = $(read(createSchema, 'files_create', 'name, and parent, content and folder where wanted', run.params));
		const name = $(requireFileName(raw));
		if (folder) {
			if (content !== undefined) {
				return $(Err(ApiErr.validationError('A folder has no content: leave content out, or folder')));
			}
			const made = $(await createFolder(changeOf(run), {parentId: parent, name}));
			return described(run, {...made, head: null}, `Made the folder ${made.name}.`);
		}
		const stored = $(await storeText(run.connection.orgId, content ?? '', maxFileBytes()));
		const made = $(await createFile(changeOf(run), {parentId: parent, name, content: {blobId: stored.blobId, size: stored.size, type: mediaType(name, undefined, 'text')}}));
		return described(run, made, `Added ${made.name}.`);
	});

const writeSchema = z.object({id: z.string().min(1), version: z.string().min(1), content: z.string()});

/** `files_write`: text written over a file, by whoever read the version it holds. */
export const runFilesWrite: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id, version, content} = $(read(writeSchema, 'files_write', 'id, version and content', run.params));
		const file = $(await requireFile(run.connection.id, id));
		// Refused before the content is stored, as the write itself refuses it once it is.
		if (file.head?.id !== version) {
			return $(Err(ApiErr.conflict(file.folder ? 'A folder has no content to write.' : staleText(file))));
		}
		const stored = $(await storeText(run.connection.orgId, content, maxFileBytes()));
		const written = $(await writeFile(changeOf(run), {fileId: id, ifVersion: version, content: {blobId: stored.blobId, size: stored.size, type: mediaType(file.name, undefined, 'text')}}));
		return described(run, written, `Wrote ${written.name}. The version before is kept.`);
	});

function staleText(file: FileFound): string {
	return `${file.name} changed since that version was read: it holds ${file.head?.id ?? 'nothing'} now. Read it again with files_read, then write.`;
}

const readSchema = z.object({id: z.string().min(1), version: z.string().min(1).optional(), from: z.number().int().nonnegative().optional()});

/** `files_read`: a file's text, a stretch at a time, as it is now or as an earlier version had it. */
export const runFilesRead: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id, version: asked, from = 0} = $(read(readSchema, 'files_read', 'id, and version and from where wanted', run.params));
		const file = $(await requireFile(run.connection.id, id));
		if (file.folder) {
			return $(Err(ApiErr.validationError(`${file.name} is a folder: files_list with it as parent lists what is inside`)));
		}
		const versionId = $(requirePresent(asked ?? file.head?.id, ApiErr.notFound('file', id)));
		const version = $(
			requirePresent($(await getFileVersion(run.connection.id, id, versionId)), ApiErr.notFound('version', versionId, `${file.name} has no version ${versionId}: files_versions lists them.`)),
		);
		const earlier = version.id === file.head?.id ? '' : ` (an earlier version: it holds ${file.head?.id ?? 'nothing'} now)`;
		const header = [`Name: ${file.name}`, `Path: ${pathOf(file)}`, `Version: ${version.id}${earlier}`, `Type: ${version.type}`, `Size: ${formatBytes(version.size)}`];
		const reading = $(await readVersion(file.name, version));
		if ('why' in reading) {
			return [...header, '', describeUnread(version, reading.why)].join('\n');
		}
		const {content, length} = stretch(reading.text, from);
		return [...header, `Length: ${length}`, '', content].join('\n');
	});

function authorText(author: VersionAuthor | null): string {
	if (author === null) {
		return '';
	}
	const restored = author.kind === 'restore' ? ', an earlier version given back' : '';
	if (author.user !== null) {
		return ` by ${author.user.name ?? author.user.email}${restored}`;
	}
	const who = author.maker?.name ?? 'an agent';
	const task = author.task === null ? '' : ` for “${author.task.title}”`;
	return ` by ${who}${task}${restored}`;
}

const idSchema = z.object({id: z.string().min(1)});

/** `files_versions`: a file's versions, newest first, with who made each. */
export const runFilesVersions: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(read(idSchema, 'files_versions', 'id', run.params));
		const file = $(await requireFile(run.connection.id, id));
		if (file.folder) {
			return $(Err(ApiErr.validationError(`${file.name} is a folder, which has no versions`)));
		}
		const versions = $(await listFileVersions(run.connection.id, id));
		const lines = versions.map(
			(version) => `${version.id}${version.id === file.head?.id ? ' (now)' : ''}: ${version.createdAt.toISOString()}, ${formatBytes(version.size)}${authorText(version.author)}`,
		);
		return [`${file.name} has ${versions.length} ${versions.length === 1 ? 'version' : 'versions'}, newest first:`, ...lines].join('\n');
	});

const restoreSchema = z.object({id: z.string().min(1), version: z.string().min(1)});

/** `files_restore`: an earlier version given back, as the file's next. */
export const runFilesRestore: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id, version} = $(read(restoreSchema, 'files_restore', 'id and version', run.params));
		const restored = $(await restoreFileVersion(changeOf(run), {fileId: id, versionId: version}));
		return described(run, restored, `${restored.name} holds what version ${version} held, as a new version.`);
	});

/** What `files_move` takes as `parent` for the top of the drive. */
const TOP = 'top';

const moveSchema = z.object({id: z.string().min(1), name: z.string().optional(), parent: z.string().min(1).optional()});

/** `files_move`: a file or folder renamed, moved to another folder, or both. */
export const runFilesMove: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id, name: raw, parent} = $(read(moveSchema, 'files_move', 'id, and name or parent, or both', run.params));
		if (raw === undefined && parent === undefined) {
			return $(Err(ApiErr.validationError('files_move takes a new name, a parent to move into, or both')));
		}
		const name = raw === undefined ? undefined : $(requireFileName(raw));
		const moved = $(await moveFile(changeOf(run), {id, name, ...(parent === undefined ? {} : {parentId: parent === TOP ? null : parent})}));
		const found = $(requirePresent($(await getFile(run.connection.id, moved.id)), ApiErr.notFound('file', id)));
		return described(run, found, `It is ${pathOf(found)} now.`);
	});

/** `files_trash`: a file or folder put in the trash. */
export const runFilesTrash: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(read(idSchema, 'files_trash', 'id', run.params));
		const trashed = $(await trashFile(changeOf(run), id));
		return `Moved ${trashed.name} to the trash. files_untrash with its id, ${trashed.id}, takes it out.`;
	});

/** `files_untrash`: what was put in the trash taken out, back where it was. */
export const runFilesUntrash: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(read(idSchema, 'files_untrash', 'id', run.params));
		const back = $(await untrashFile(changeOf(run), id));
		const found = $(requirePresent($(await getFile(run.connection.id, back.id)), ApiErr.notFound('file', id)));
		return described(run, found, `Took ${pathOf(found)} out of the trash.`);
	});
