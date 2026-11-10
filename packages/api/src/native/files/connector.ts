import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getFile, getFileVersion, listFolder, searchFiles, type FileEntry, type FileFound} from '@proxy/db/files';

import {type DataRecord, type RecordStore, type RecordTarget, requireFirstPage} from '../../records/connector';
import {describeUnread, readVersion, stretch} from './text';

/**
 * A drive's folders and files as records: a tree, listed a folder at a time, folders first, or
 * searched by name, anywhere or inside the folder opened; a file opens with its text, the first
 * of it where it is long, or with what it is where it isn't text. Only read here: every write is
 * a tool of the integration's own (tools.ts), which names who made it. What is in the trash is
 * not found.
 */

function toRecord(entry: FileEntry, content = ''): DataRecord {
	const modified = entry.updatedAt.toISOString();
	return {
		id: entry.id,
		values: {name: entry.name, kind: entry.folder ? 'Folder' : 'File', modified, owner: '', content},
		updatedAt: modified,
		...(entry.folder ? {hasChildren: true} : {}),
	};
}

/** A file or folder of the drive outside the trash, or not found. */
export function requireFile(connectionId: string, id: string): Promise<Result<FileFound, ApiError>> {
	return Do(async ($) => {
		const found = $(requirePresent($(await getFile(connectionId, id)), ApiErr.notFound('file', id)));
		if (found.trashed) {
			return $(Err(ApiErr.notFound('file', id, 'It is in the trash.')));
		}
		return found;
	});
}

// The folder a list is opened in, with the folders above it.
function requireFolder(target: RecordTarget, parent: string): Promise<Result<FileFound, ApiError>> {
	return Do(async ($) => {
		const folder = $(await requireFile(target.connection.id, parent));
		if (!folder.folder) {
			return $(Err(ApiErr.validationError(`${folder.name} is a file, which holds nothing to list: open it instead`)));
		}
		return folder;
	});
}

// A file's text as its record's content: the first stretch of it, or what the file is.
function contentOf(file: FileFound): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (file.head === null) {
			return '';
		}
		const version = $(requirePresent($(await getFileVersion(file.connectionId, file.id, file.head.id)), ApiErr.notFound('file', file.id)));
		const reading = $(await readVersion(file.name, version));
		if ('why' in reading) {
			return describeUnread(version, reading.why);
		}
		const {content, length} = stretch(reading.text, 0);
		return content.length < reading.text.length ? `${content}\n\n[${length}]` : content;
	});
}

/** The files collection's connector: the drive's tree, read. */
export const filesConnector = {
	// A folder's own are few enough to list on one page; a search answers its first hundred.
	list: (target, query) =>
		Do(async ($) => {
			$(requireFirstPage(query));
			const folder = query.parent === null ? null : $(await requireFolder(target, query.parent));
			const trail = folder === null ? undefined : [...folder.trail, folder].map((crumb) => ({id: crumb.id, title: crumb.name}));
			const search = query.search?.trim();
			const entries = search ? $(await searchFiles(target.connection.id, search, folder?.id ?? null)) : $(await listFolder(target.connection.id, folder?.id ?? null));
			return {records: entries.map((entry) => toRecord(entry)), nextPage: null, ...(trail ? {trail} : {})};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const file = $(await requireFile(target.connection.id, recordId));
			return toRecord(file, file.folder ? '' : $(await contentOf(file)));
		}),
} satisfies RecordStore;
