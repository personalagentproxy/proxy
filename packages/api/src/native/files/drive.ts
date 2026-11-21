import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {CliExport, CliFile, cliFileListSchema, CliPulled} from '@proxy/contracts/cli';
import {checkNewFile, createFile, ensureFolder, FILE_CHANGED, type FileChangeBy, type FileEntry, type FileFound, findPath, getFile, getFileVersion, listFolder, writeFile} from '@proxy/db/files';

import type {RunTarget} from '../../agent-side/tools';
import {type AgentBlob, type BlobFile, blobType} from '../../blobs/blobs';
import {requireReadFile} from './attached';
import {requireFile} from './connector';
import {openContent} from './content';
import {fileLink} from './links';
import {requireFileName} from './names';
import {pathOf} from './text';

/**
 * A drive's files as bytes, one of each kind that keeps files: Files, kept here (`filesDrive`),
 * and Google Drive (records/google-drive.ts). What is the same for every drive is done once, by
 * `pap files` (cli.ts), by path, and by files_blob and files_upload (blobs/drive-tools.ts), by id:
 * the gate, the log, which path is a new file and which a write over one, and the version a write
 * names. The drive does what is its own: what a path names in it, what a folder holds, a file's
 * bytes, and putting a blob in it, as a new file or a file's next version, as the run's agent's,
 * for its task, in the drive's history.
 */

export type DriveListing = z.infer<typeof cliFileListSchema>;

/** What a path is in a drive: the files and folders on it that are there, from the top, and the names past the last of them that aren't. */
export type ResolvedPath = {found: CliFile[]; missing: string[]};

/**
 * A pull: the file by its id; the version asked for, else what it holds now; what it is exported
 * as, for a file with no bytes of its own, and the tab of a Sheet as CSV; and its path, where the
 * pull wants one, as `pap files pull` does to note where a file came from. Without one, a drive
 * that has to look a path up says none.
 */
export type PullAsked = {id: string; version: string | null; as: CliExport | null; tab: string | null; path: string | null};

/** A file's bytes as they come, and which file they are. */
export type FilePull = {said: CliPulled; body: ReadableStream<Uint8Array>};

/** The version a write over a file names: the one pulled, if any, or, with force, whatever it holds now. */
export type WriteAsk = {version: string | null; force: boolean};

/**
 * Where a blob goes: a new file in a folder, the top where `parentId` is null, inside the `folders`
 * made in it on the way, where a push to a path names folders that are missing, and `convert`ed
 * into the drive's own kind of file where the drive has one, as Google Drive makes a Doc of a docx;
 * or the next version of a file, by whoever read `version`.
 */
export type UploadTarget = {kind: 'create'; parentId: string | null; folders: string[]; name: string; convert: boolean} | {kind: 'write'; fileId: string; version: string};

/** The file a blob was put in: its id, its name, the version that holds the bytes, and where the person opens it. */
export type UploadMade = {fileId: string; name: string; version: string; link: string};

/** Who reaches the drive, for which task, and the connection. */
export type DriveAt = Pick<RunTarget, 'caller' | 'connection'>;

export type Drive = {
	/** The tools a listing and a pull are checked and logged as: the drive's own reads. */
	reads: {list: string; pull: string};
	/** A path as its names, from the drive's top: none for the top. */
	namesOf: (path: string) => Result<string[], ApiError>;
	/** The names of the file a push goes to, converted where `convert` says: refused where the drive has nothing to convert into, or no file goes there. */
	pushNames: (names: string[], convert: boolean) => Result<string[], ApiError>;
	/** What a path names, as far as it goes. */
	resolve: (names: string[]) => Promise<Result<ResolvedPath, ApiError>>;
	/** A file by its id, with its path. */
	file: (id: string) => Promise<Result<CliFile, ApiError>>;
	/** What the folder at a path holds. */
	list: (names: string[]) => Promise<Result<DriveListing, ApiError>>;
	/** A file's bytes, as they come. */
	pull: (asked: PullAsked) => Promise<Result<FilePull, ApiError>>;
	/**
	 * What putting a file there would be refused for, checked before its bytes are sent, as `upload`
	 * checks it again once they are: where it goes, what it is called, the version read, and what its
	 * bytes may be, by the name and type it would have as a blob. Nothing is made.
	 */
	check: (target: UploadTarget, file: BlobFile) => Promise<Result<void, ApiError>>;
	/** Puts a blob in the drive, as the agent's, for its task: a new file, or a file's next version, still at the version read. */
	upload: (target: UploadTarget, blob: AgentBlob) => Promise<Result<UploadMade, ApiError>>;
};

/**
 * The version a write over `there` is made at: the one pulled, or with force, whatever it holds
 * now; refused where the file changed since it was pulled, or was never pulled.
 */
export function versionToWrite(there: CliFile, ask: WriteAsk): Result<string, ApiError> {
	const held = there.version ?? '';
	const named = ask.force ? held : ask.version;
	if (named === held) {
		return Ok(held);
	}
	const why = named === null ? `${there.path} is there already` : `${there.path} changed since it was pulled`;
	return Err(ApiErr.conflict(`${why}: it holds version ${held} now. Pull it again and push what you make of that, or push with --force to write over it; the version before is kept either way.`));
}

function toCliFile(entry: FileEntry, path: string): CliFile {
	return {id: entry.id, name: entry.name, path, folder: entry.folder, version: entry.head?.id ?? null, size: entry.head?.size ?? null, type: entry.head?.type ?? null};
}

// A path as its names, each as a name in Files may be.
function namesOf(path: string): Result<string[], ApiError> {
	const names: string[] = [];
	for (const part of path.split('/')) {
		if (part.trim() === '') {
			continue;
		}
		const name = requireFileName(part);
		if (name.isErr()) {
			return Err(name.error);
		}
		names.push(name.value);
	}
	return Ok(names);
}

const KEPT_AS_IS = 'Files keeps every file as its bytes, of its own type';

// The file a blob goes over: one of the drive's, outside the trash, that holds bytes.
function fileOver(connectionId: string, target: Extract<UploadTarget, {kind: 'write'}>): Promise<Result<FileFound, ApiError>> {
	return Do(async ($) => {
		const found = $(await requireFile(connectionId, target.fileId));
		if (found.folder) {
			return $(Err(ApiErr.validationError(`${found.name} is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it`)));
		}
		return found;
	});
}

// A new file's name, where one called that can go: as its bytes, in a folder that is there, with
// nothing in the way of it or of the first of the folders made on the way.
function newFileName(connectionId: string, target: Extract<UploadTarget, {kind: 'create'}>): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (target.convert) {
			return $(Err(ApiErr.validationError(`${KEPT_AS_IS}: leave convert out`)));
		}
		const name = $(requireFileName(target.name));
		for (const folder of target.folders) {
			$(requireFileName(folder));
		}
		$(await checkNewFile(connectionId, {parentId: target.parentId, name: target.folders[0] ?? name}));
		return name;
	});
}

// What a blob put in Files would be refused for, before there is one: the version read is checked
// here as the write itself checks it.
function checkFilesUpload(connectionId: string, target: UploadTarget): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (target.kind === 'create') {
			$(await newFileName(connectionId, target));
			return;
		}
		const found = $(await fileOver(connectionId, target));
		if (found.head?.id !== target.version) {
			return $(Err(ApiErr.conflict(FILE_CHANGED)));
		}
	});
}

// A blob put in Files: the blob becomes the file's version as it is, so a file of Files holds the
// very bytes that arrived. What a write checks, it checks again as it is made.
function uploadToFiles(at: DriveAt, target: UploadTarget, blob: AgentBlob): Promise<Result<UploadMade, ApiError>> {
	return Do(async ($) => {
		const {caller, connection} = at;
		const change: FileChangeBy = {orgId: connection.orgId, connectionId: connection.id, by: {agentId: caller.agent.agentId, taskId: caller.taskId}};
		const made = await Do<FileEntry, ApiError>(async ($$) => {
			if (target.kind === 'write') {
				const found = $$(await fileOver(connection.id, target));
				const content = {blobId: blob.id, size: blob.size, type: blobType(blob, found.name)};
				return $$(await writeFile(change, {fileId: found.id, ifVersion: target.version, content}));
			}
			const name = $$(await newFileName(connection.id, target));
			// The folders on the way, made where they are still missing, each the agent's as the file is.
			let parentId = target.parentId;
			for (const folder of target.folders) {
				parentId = $$(await ensureFolder(change, {parentId, name: folder})).id;
			}
			const content = {blobId: blob.id, size: blob.size, type: blobType(blob, name)};
			return $$(await createFile(change, {parentId, name, content}));
		});
		const file = $(made);
		const version = $(requirePresent(file.head, ApiErr.internalError(new Error(`Putting blob ${blob.id} in Files made no version.`))));
		const found = $(await getFile(connection.id, file.id));
		return {fileId: file.id, name: file.name, version: version.id, link: fileLink(caller.agent.orgSlug, connection.id, found ?? file)};
	});
}

/** A drive of Files, in the database and the blob store, as the run's agent reaches it. */
export function filesDrive(at: DriveAt): Drive {
	const connectionId = at.connection.id;
	return {
		reads: {list: 'files_read', pull: 'files_read'},
		namesOf,
		pushNames: (names, convert) => (convert ? Err(ApiErr.validationError(`${KEPT_AS_IS}: push it without --convert.`)) : Ok(names)),

		resolve: (names) =>
			Do(async ($) => {
				const {found, missing} = $(await findPath(connectionId, names));
				return {found: found.map((entry, index) => toCliFile(entry, names.slice(0, index + 1).join('/'))), missing};
			}),

		file: (id) =>
			Do(async ($) => {
				const found = $(await requireFile(connectionId, id));
				return toCliFile(found, pathOf(found));
			}),

		list: (names) =>
			Do(async ($) => {
				const where = names.join('/');
				const {found, missing} = $(await findPath(connectionId, names));
				const folder = found.at(-1) ?? null;
				if (missing.length > 0) {
					return $(Err(ApiErr.notFound('folder', where, `There is no ${where} in this drive.`)));
				}
				if (folder !== null && !folder.folder) {
					return $(Err(ApiErr.validationError(`${where} is a file: pap files pull reads it.`)));
				}
				const entries = $(await listFolder(connectionId, folder?.id ?? null));
				return {path: where, files: entries.map((entry) => toCliFile(entry, where === '' ? entry.name : `${where}/${entry.name}`))};
			}),

		pull: ({id, version: asked, as, tab}) =>
			Do(async ($) => {
				if (as !== null || tab !== null) {
					return $(Err(ApiErr.validationError(`${KEPT_AS_IS}, and hands it over as they are: leave as and tab out.`)));
				}
				const file = $(await requireReadFile(at.caller, connectionId, id, asked ?? undefined));
				if (file.folder) {
					return $(Err(ApiErr.validationError(`${file.name} is a folder, which holds no bytes.`)));
				}
				const versionId = $(requirePresent(asked ?? file.head?.id, ApiErr.notFound('file', id)));
				const version = $(requirePresent($(await getFileVersion(connectionId, file.id, versionId)), ApiErr.notFound('version', versionId, `${file.name} has no version ${versionId}.`)));
				const said: CliPulled = {id: file.id, name: file.name, path: pathOf(file), folder: false, version: version.id, size: version.size, type: version.type, format: null};
				return {said, body: $(await openContent(version.blob))};
			}),

		check: (target) => checkFilesUpload(connectionId, target),

		upload: (target, blob) => uploadToFiles(at, target, blob),
	};
}
