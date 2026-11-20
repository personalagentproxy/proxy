import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {CliConversion, CliExport, CliFile, cliFileListSchema, CliPulled, cliPushedSchema} from '@proxy/contracts/cli';
import {type FileEntry, findPath, getFileVersion, listFolder} from '@proxy/db/files';

import type {RunTarget} from '../../agent-side/tools';
import {finishUpload, startUpload, type UploadRun, type UploadTicket} from '../../uploads/tickets';
import {requireReadFile} from './attached';
import {requireFile} from './connector';
import {openContent} from './content';
import {requireFileName} from './names';
import {pathOf} from './text';
import {filesUploads} from './uploads';

/**
 * A drive as `pap files` reaches it (cli.ts), one of each kind that keeps files: Files, kept here
 * (`filesCliDrive`), and Google Drive (records/google-cli.ts). The routes do what is the same for
 * every drive, the gate, the log, which path is a new file and which a write over one, and the
 * version a write names; the drive does what is its own: what a path names in it, what a folder
 * holds, a file's bytes, and starting and finishing an upload of them, through its `DriveUploads`
 * (uploads/tickets.ts), as files_upload and files_upload_done do.
 */

export type CliListed = z.infer<typeof cliFileListSchema>;

export type CliPushed = z.infer<typeof cliPushedSchema>;

/** What a path is in a drive: the files and folders on it that are there, from the top, and the names past the last of them that aren't. */
export type CliResolved = {found: CliFile[]; missing: string[]};

/**
 * A pull: the file by its id; the version asked for, else what it holds now; what it is exported
 * as, for a file with no bytes of its own, and the tab of a Sheet as CSV; and its path, where it
 * was found by one.
 */
export type CliPullAsked = {id: string; version: string | null; as: CliExport | null; tab: string | null; path: string | null};

/** A file's bytes as they come, and which file they are. */
export type CliPull = {said: CliPulled; body: ReadableStream<Uint8Array>};

/**
 * What a push says of what it sends: its size and SHA-256; the name of the file it is sent from,
 * whose extension says what the bytes are; and what a new file is made into, where the drive makes
 * its own kinds of file.
 */
export type CliPush = {size: number; sha256: string; file: string | null; as: CliConversion | null};

/** The version a write over a file names: the one pulled, if any, or, with force, whatever it holds now. */
export type CliAsk = {version: string | null; force: boolean};

/** A new file: in the folder `parent`, the top where it is null, inside the `folders` missing on the way. */
export type CliCreate = {parent: CliFile | null; folders: string[]; name: string};

export type CliDrive = {
	/** The tools a listing and a pull are checked and logged as: the drive's own reads. */
	reads: {list: string; pull: string};
	/** A path as its names, from the drive's top: none for the top. */
	namesOf: (path: string) => Result<string[], ApiError>;
	/** The names of the file a push goes to, as `as` makes it: refused where the drive makes nothing of `as`. */
	pushNames: (names: string[], as: CliConversion | null) => Result<string[], ApiError>;
	/** What a path names, as far as it goes. */
	resolve: (names: string[]) => Promise<Result<CliResolved, ApiError>>;
	/** A file by its id, as a push names one to write over. */
	file: (id: string) => Promise<Result<CliFile, ApiError>>;
	/** What the folder at a path holds. */
	list: (names: string[]) => Promise<Result<CliListed, ApiError>>;
	pull: (asked: CliPullAsked) => Promise<Result<CliPull, ApiError>>;
	/** Starts an upload of a new file, as files_upload does. */
	startCreate: (run: UploadRun, create: CliCreate, push: CliPush) => Promise<Result<UploadTicket, ApiError>>;
	/** Starts an upload of a file's next version, at the version `ask` names (`versionToWrite`). */
	startWrite: (run: UploadRun, there: CliFile, push: CliPush, ask: CliAsk) => Promise<Result<UploadTicket, ApiError>>;
	/** Finishes an upload, as files_upload_done does, and answers the file it made. */
	finish: (run: UploadRun, upload: string) => Promise<Result<CliPushed, ApiError>>;
};

/**
 * The version a write over `there` is made at: the one pulled, or with force, whatever it holds
 * now; refused where the file changed since it was pulled, or was never pulled.
 */
export function versionToWrite(there: CliFile, ask: CliAsk): Result<string, ApiError> {
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

/** A drive of Files, in the database and the blob store, as the target's agent reaches it. */
export function filesCliDrive(target: RunTarget): CliDrive {
	const connectionId = target.connection.id;
	return {
		reads: {list: 'files_read', pull: 'files_read'},
		namesOf,
		pushNames: (names, as) => (as === null ? Ok(names) : Err(ApiErr.validationError(`${KEPT_AS_IS}: push it without --as.`))),

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
				const at = names.join('/');
				const {found, missing} = $(await findPath(connectionId, names));
				const folder = found.at(-1) ?? null;
				if (missing.length > 0) {
					return $(Err(ApiErr.notFound('folder', at, `There is no ${at} in this drive.`)));
				}
				if (folder !== null && !folder.folder) {
					return $(Err(ApiErr.validationError(`${at} is a file: pap files pull reads it.`)));
				}
				const entries = $(await listFolder(connectionId, folder?.id ?? null));
				return {path: at, files: entries.map((entry) => toCliFile(entry, at === '' ? entry.name : `${at}/${entry.name}`))};
			}),

		pull: ({id, version: asked, as, tab}) =>
			Do(async ($) => {
				if (as !== null || tab !== null) {
					return $(Err(ApiErr.validationError(`${KEPT_AS_IS}, and pulls it as they are: leave --as and --tab out.`)));
				}
				const file = $(await requireReadFile(target.caller, connectionId, id, asked ?? undefined));
				if (file.folder) {
					return $(Err(ApiErr.validationError(`${file.name} is a folder: pap files ls lists it.`)));
				}
				const versionId = $(requirePresent(asked ?? file.head?.id, ApiErr.notFound('file', id)));
				const version = $(requirePresent($(await getFileVersion(connectionId, file.id, versionId)), ApiErr.notFound('version', versionId, `${file.name} has no version ${versionId}.`)));
				const said: CliPulled = {id: file.id, name: file.name, path: pathOf(file), folder: false, version: version.id, size: version.size, type: version.type, format: null};
				return {said, body: $(await openContent(version.blob))};
			}),

		startCreate: (run, {parent, folders, name}, push) =>
			startUpload(run, filesUploads, {kind: 'create', parentId: parent?.id ?? null, folders, name, convert: false}, {size: push.size, sha256: push.sha256, type: null}),

		startWrite: (run, there, push, ask) =>
			Do(async ($) => {
				const held = $(versionToWrite(there, ask));
				return $(await startUpload(run, filesUploads, {kind: 'write', fileId: there.id, version: held}, {size: push.size, sha256: push.sha256, type: null}));
			}),

		finish: (run, upload) =>
			Do(async ($) => {
				const done = $(await finishUpload(run, filesUploads, upload));
				const {fileId, version: versionId} = done.made;
				const made = $(await requireFile(connectionId, fileId));
				const version = $(requirePresent($(await getFileVersion(connectionId, fileId, versionId)), ApiErr.notFound('version', versionId)));
				const file: CliFile = {id: made.id, name: made.name, path: pathOf(made), folder: false, version: version.id, size: version.size, type: version.type};
				return {file, created: done.created, link: done.link};
			}),
	};
}
