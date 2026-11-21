import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {CliExport, CliFile, CliPulled} from '@proxy/contracts/cli';

import {
	downloadFile,
	downloadRevision,
	driveQuoted,
	driveVersion,
	exportBytes,
	fileIdOf,
	getFileState,
	isGoogleType,
	listFileStates,
	listSharedDrives,
	MIME_TYPES,
	type DriveFileState,
	type SharedDrive,
} from '../connections/google/drive-api';
import {callGoogle, TOO_LARGE_TO_READ} from '../connections/google/google-client';
import {getSheets, getValues, rowsRange} from '../connections/google/sheets-api';
import type {DriveListing, FilePull, PullAsked, ResolvedPath, Drive, DriveAt} from '../native/files/drive';
import {mediaType} from '../native/files/names';
import {pathInDrive} from './google-files';
import {sizeOf} from './google-history';
import {checkDriveUpload, CONVERTED_EXTENSION, GOOGLE_KINDS, uploadToDrive} from './google-uploads';

/**
 * A Google account's Drive as `pap files` reaches it (native/files/drive.ts), by path, as
 * Drive itself shows it: at the top, My Drive, Shared drives, which holds a folder for each shared
 * drive by its name, and Shared with me; so `My Drive/Reports/q3.pdf`, `Shared drives/Research/…`
 * and `Shared with me/…`. Drive lets more than one file in a folder have the same name, so a path
 * whose name matches more than one is refused with their ids, and the file is named by its id
 * instead.
 *
 * A file with bytes of its own comes down as those bytes, from Drive through here as they come; a
 * Doc, Sheet or Slides file has none, and comes as Drive exports it, up to the 10 MB Drive
 * exports: a Doc as Markdown, a Sheet as xlsx and a Slides file as pptx, unless the pull asks for
 * another, and a Sheet as CSV is its first tab, or the one asked for, read through the Sheets API.
 * Its version is Drive's: the head revision of a file with bytes, a Doc's, Sheet's or Slides file's
 * version number, which goes up with each change.
 *
 * A blob put in Drive goes up as its bytes, or, asked to, is made a Doc, Sheet or Slides file of a
 * docx, Markdown, xlsx, CSV or pptx (google-uploads.ts); the folders on the way to a path pushed to
 * that are missing are made with the file, logged as the agent's. Over a file with bytes of its
 * own, the version pulled is named, or the push says to write over it, and the task's copy is kept
 * first (google-history.ts). A Doc, Sheet or Slides file is never written over, which would lose
 * its comments, suggestions and whatever the bytes can't hold: the refusal points to the tools that
 * edit it in place.
 */

// The media type of a file of the extension, as Files reads it.
function typeOf(extension: string): string {
	return mediaType(`file.${extension}`, undefined, 'bytes');
}

/** The top's places, with the record ids the files collection gives them (google-files.ts). */
const PLACES = [
	{id: 'root', name: 'My Drive'},
	{id: 'shared-drives', name: 'Shared drives'},
	{id: 'shared-with-me', name: 'Shared with me'},
] as const;

type Place = (typeof PLACES)[number];

const PATHS_START = 'A path in Google Drive starts at one of its places: My Drive, Shared drives and the drive’s name, or Shared with me, as My Drive/Reports/q3.pdf. pap files ls lists them.';

/** What is inside a folder, as Drive is asked for it: files, by a query and where to look, or the shared drives. */
type Inside = {kind: 'files'; q: string; params: Record<string, string>} | {kind: 'drives'};

function inParents(id: string): string {
	return `${driveQuoted(id)} in parents`;
}

function insideOfPlace(place: Place): Inside {
	if (place.id === 'root') {
		return {kind: 'files', q: inParents('root'), params: {}};
	}
	if (place.id === 'shared-with-me') {
		return {kind: 'files', q: 'sharedWithMe = true', params: {}};
	}
	return {kind: 'drives'};
}

function insideOfDrive(driveId: string): Inside {
	return {kind: 'files', q: inParents(driveId), params: {corpora: 'drive', driveId}};
}

function insideOfFolder(file: DriveFileState): Inside {
	return {kind: 'files', q: inParents(file.id), params: file.driveId ? {corpora: 'drive', driveId: file.driveId} : {}};
}

function placeFile(place: Place): CliFile {
	return {id: place.id, name: place.name, path: place.name, folder: true, version: null, size: null, type: null};
}

function driveFile(drive: SharedDrive, path: string): CliFile {
	return {id: `drive-${drive.id}`, name: drive.name, path, folder: true, version: null, size: null, type: null};
}

function fileOf(file: DriveFileState, path: string): CliFile {
	const folder = file.mimeType === MIME_TYPES.folder;
	return {id: file.id, name: file.name, path, folder, version: driveVersion(file), size: folder ? null : sizeOf(file), type: file.mimeType};
}

// What a file is, in a word, for a list of those that share a name.
function kindOf(mimeType: string): string {
	if (mimeType === MIME_TYPES.folder) {
		return 'folder';
	}
	return GOOGLE_KINDS[mimeType]?.name ?? mimeType;
}

// A name that matches more than one file, refused with each of them, so one is named by its id.
function ambiguous(where: string, name: string, matches: {id: string; kind: string; modified?: string}[]): ApiError {
	const listed = matches.map((match) => `${match.id} (${match.kind}${match.modified ? `, changed ${match.modified}` : ''})`).join(', ');
	return ApiErr.validationError(
		`More than one file in ${where} is called “${name}”: ${listed}. Name the one you mean by its id: pap files pull <connection> --id <id>, or pap files push <file> <connection> --id <id> to write over it.`,
	);
}

// The shared drives the account is in, as many as one listing takes, those named `search` when given.
const LISTED = 1000;

function sharedDrives(token: string, search: string | null): Promise<Result<{drives: SharedDrive[]; more: boolean}, ApiError>> {
	return Do(async ($) => {
		const drives: SharedDrive[] = [];
		let page: string | null = null;
		do {
			const listed: {items: SharedDrive[]; nextPage: string | null} = $(await listSharedDrives(token, search, page));
			drives.push(...listed.items);
			page = listed.nextPage;
		} while (page !== null && drives.length < LISTED);
		return {drives, more: page !== null};
	});
}

type Step = {file: CliFile; inside: Inside | null};

// The one file or shared drive called `name` inside, at the path `where`; none where nothing is.
function childNamed(token: string, inside: Inside, where: string, name: string): Promise<Result<Step | null, ApiError>> {
	return Do(async ($) => {
		const path = `${where}/${name}`;
		if (inside.kind === 'drives') {
			const {drives} = $(await sharedDrives(token, name));
			const named = drives.filter((drive) => drive.name === name);
			const [drive, ...others] = named;
			if (others.length > 0) {
				return $(
					Err(
						ambiguous(
							where,
							name,
							named.map((one) => ({id: `drive-${one.id}`, kind: 'shared drive'})),
						),
					),
				);
			}
			return drive === undefined ? null : {file: driveFile(drive, path), inside: insideOfDrive(drive.id)};
		}
		const q = `${inside.q} and name = ${driveQuoted(name)} and trashed = false`;
		const listed = $(await listFileStates(token, q, {...inside.params, pageSize: '10'}, null));
		const named = listed.items.filter((file) => file.name === name);
		const [file, ...others] = named;
		if (others.length > 0) {
			return $(
				Err(
					ambiguous(
						where,
						name,
						named.map((one) => ({id: one.id, kind: kindOf(one.mimeType), modified: one.modifiedTime})),
					),
				),
			);
		}
		if (file === undefined) {
			return null;
		}
		return {file: fileOf(file, path), inside: file.mimeType === MIME_TYPES.folder ? insideOfFolder(file) : null};
	});
}

/** What a path names, as far as it goes, and what is inside the last of it, where that is a folder. */
type Walked = ResolvedPath & {inside: Inside | null};

function walk(token: string, names: string[]): Promise<Result<Walked, ApiError>> {
	return Do(async ($) => {
		const [top, ...rest] = names;
		if (top === undefined) {
			return {found: [], missing: [], inside: null};
		}
		const place = PLACES.find((candidate) => candidate.name === top);
		if (place === undefined) {
			return $(Err(ApiErr.validationError(PATHS_START)));
		}
		const found: CliFile[] = [placeFile(place)];
		let inside = insideOfPlace(place);
		for (const [index, name] of rest.entries()) {
			const step = $(await childNamed(token, inside, names.slice(0, index + 1).join('/'), name));
			if (step === null) {
				return {found, missing: rest.slice(index), inside: null};
			}
			found.push(step.file);
			if (step.inside === null) {
				return {found, missing: rest.slice(index + 1), inside: null};
			}
			inside = step.inside;
		}
		return {found, missing: [], inside};
	});
}

// What is inside a folder, as many as one listing takes, folders first, by name.
function listInside(token: string, inside: Inside, where: string): Promise<Result<{files: CliFile[]; more: boolean}, ApiError>> {
	return Do(async ($) => {
		if (inside.kind === 'drives') {
			const {drives, more} = $(await sharedDrives(token, null));
			return {files: drives.map((drive) => driveFile(drive, `${where}/${drive.name}`)), more};
		}
		const params = {...inside.params, pageSize: String(LISTED), orderBy: 'folder,name'};
		const listed = $(await listFileStates(token, `${inside.q} and trashed = false`, params, null));
		return {files: listed.items.map((file) => fileOf(file, `${where}/${file.name}`)), more: listed.nextPage !== null};
	});
}

// ---- Pulling ------------------------------------------------------------------------------------

/** What each of Google's own kinds of file is exported as: the kind's name, what it is pulled as unless asked otherwise, and what it can be. */
const EXPORTS: Partial<Record<string, {kind: string; standard: CliExport; formats: CliExport[]}>> = {
	[MIME_TYPES.document]: {kind: 'Doc', standard: 'md', formats: ['md', 'docx', 'pdf', 'txt']},
	[MIME_TYPES.spreadsheet]: {kind: 'Sheet', standard: 'xlsx', formats: ['xlsx', 'csv', 'pdf']},
	[MIME_TYPES.presentation]: {kind: 'Slides file', standard: 'pptx', formats: ['pptx', 'pdf', 'txt']},
};

// What is smaller than an export past Drive's 10 MB, for each kind.
const SMALLER: Partial<Record<string, string>> = {
	[MIME_TYPES.document]: ', as md or txt',
	[MIME_TYPES.spreadsheet]: ', as one tab, as csv with its tab',
	[MIME_TYPES.presentation]: ', as txt',
};

/** A file's name as the sandbox's file is called: no slash, which would make it a path there, and never `.` or `..`. */
function localName(name: string): string {
	const flat = name.replace(/[/\\]/g, '_');
	return flat === '.' || flat === '..' || flat.trim() === '' ? '_' : flat;
}

// A name with the export's extension, where it doesn't end with it already.
function withExtension(name: string, extension: string): string {
	return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function csvField(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Rows as CSV, each as wide as the widest, as Sheets' own export writes them.
function csvOf(rows: string[][]): string {
	const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
	return rows.map((row) => Array.from({length: width}, (_, column) => csvField(row[column] ?? '')).join(',')).join('\r\n') + (rows.length > 0 ? '\r\n' : '');
}

// One tab of a spreadsheet as CSV, its values as Sheets shows them, read through the Sheets API.
function tabCsv(token: string, file: DriveFileState, title: string): Promise<Result<Uint8Array<ArrayBuffer>, ApiError>> {
	return Do(async ($) => {
		const sheets = $(await getSheets(token, file.id));
		const sheet = sheets.find((candidate) => candidate.title === title);
		if (sheet === undefined) {
			return $(Err(ApiErr.validationError(`“${file.name}” has no tab “${title}”: its tabs are ${sheets.map((one) => `“${one.title}”`).join(', ')}.`)));
		}
		if (sheet.rowCount === 0) {
			return new Uint8Array();
		}
		const {values} = $(await getValues(token, file.id, rowsRange(sheet.title, 1, sheet.rowCount)));
		return new TextEncoder().encode(csvOf(values));
	});
}

// A Doc, Sheet or Slides file exported as `format`; one past Drive's 10 MB says what is smaller.
function exported(token: string, file: DriveFileState, format: CliExport): Promise<Result<ReadableStream<Uint8Array>, ApiError>> {
	return Do(async ($) => {
		const bytes = await exportBytes(token, file.id, typeOf(format));
		if (bytes.isErr() && bytes.error.kind === 'validation_error' && bytes.error.message === TOO_LARGE_TO_READ) {
			return $(
				Err(ApiErr.validationError(`“${file.name}” is too large to export as ${format}: Drive exports at most 10 MB. Ask for it as pdf, or as something smaller${SMALLER[file.mimeType] ?? ''}.`)),
			);
		}
		return $(bytes);
	});
}

// A Doc, Sheet or Slides file, as Drive exports it now.
function pullExport(token: string, file: DriveFileState, asked: PullAsked, path: string): Promise<Result<FilePull, ApiError>> {
	return Do(async ($) => {
		const exports = EXPORTS[file.mimeType];
		if (exports === undefined) {
			return $(Err(ApiErr.validationError(`Drive exports nothing of “${file.name}”, which is ${file.mimeType}${file.webViewLink ? `; open it at ${file.webViewLink}` : ''}.`)));
		}
		const format = asked.as ?? exports.standard;
		if (!exports.formats.includes(format)) {
			return $(Err(ApiErr.validationError(`A ${exports.kind} is pulled as ${exports.formats.join(', ')}, not ${format}.`)));
		}
		if (asked.tab !== null && format !== 'csv') {
			return $(Err(ApiErr.validationError('tab names the tab of a Sheet as CSV: ask for it as csv with its tab.')));
		}
		const version = $(requirePresent(driveVersion(file), ApiErr.notFound('version', file.id)));
		if (asked.version !== null && asked.version !== version) {
			return $(
				Err(
					ApiErr.validationError(
						`Drive exports “${file.name}” only as it is now, at version ${version}: ask for it without a version. What it held before is read with the files_version_read tool, a version from files_versions, and in Drive’s own version history.`,
					),
				),
			);
		}
		const said: CliPulled = {id: file.id, name: localName(withExtension(file.name, format)), path, folder: false, version, size: null, type: typeOf(format), format};
		if (asked.tab !== null) {
			const csv = $(await tabCsv(token, file, asked.tab));
			return {said: {...said, size: csv.length}, body: new Blob([csv]).stream()};
		}
		return {said, body: $(await exported(token, file, format))};
	});
}

// A file with bytes of its own, as they are: now, or at one of its revisions.
function pullBytes(token: string, file: DriveFileState, asked: PullAsked, path: string): Promise<Result<FilePull, ApiError>> {
	return Do(async ($) => {
		if (asked.as !== null || asked.tab !== null) {
			return $(Err(ApiErr.validationError(`“${file.name}” is a file of its own bytes, ${file.mimeType}, and is handed over as they are: leave as and tab out.`)));
		}
		const head = file.headRevisionId ?? null;
		const now = asked.version === null || asked.version === head;
		const version = $(requirePresent(now ? head : asked.version, ApiErr.notFound('version', file.id)));
		const body = now ? $(await downloadFile(token, file.id)) : $(await downloadRevision(token, file.id, version));
		const said: CliPulled = {id: file.id, name: localName(file.name), path, folder: false, version, size: now ? sizeOf(file) : null, type: file.mimeType, format: null};
		return {said, body};
	});
}

/** A Google account's Drive, as the run's agent reaches it. */
export function googleDrive(at: DriveAt): Drive {
	const {connection} = at;
	const withToken = <T>(call: (token: string) => Promise<Result<T, ApiError>>) => callGoogle(connection, call);

	// A file by its id or its link, with its path.
	const fileNamed = (id: string) =>
		withToken((token) =>
			Do(async ($) => {
				const fileId = $(requirePresent(fileIdOf(id), ApiErr.notFound('file', id, `There is no file ${id} in this drive: give its id, as pap files ls lists it, or its link.`)));
				const file = $(await getFileState(token, fileId));
				return {file, path: $(await pathInDrive(token, file)).join('/')};
			}),
		);

	return {
		reads: {list: 'files_list', pull: 'files_get'},

		// Drive's names may be anything but empty; a slash in one leaves it to be named by its id.
		namesOf: (path) => Ok(path.split('/').filter((part) => part.trim() !== '')),

		// Where a file goes has a place first, and one converted goes without its extension, as
		// Drive's own import makes it.
		pushNames: (names, convert) => {
			const last = names.at(-1);
			if (last === undefined || names.length < 2) {
				return Err(ApiErr.validationError(PATHS_START));
			}
			if (!convert) {
				return Ok(names);
			}
			const bare = last.replace(CONVERTED_EXTENSION, '').trim();
			return Ok([...names.slice(0, -1), bare === '' ? last : bare]);
		},

		resolve: (names) =>
			withToken((token) =>
				Do(async ($) => {
					const {found, missing} = $(await walk(token, names));
					return {found, missing};
				}),
			),

		file: (id) =>
			Do(async ($) => {
				const {file, path} = $(await fileNamed(id));
				return fileOf(file, path);
			}),

		list: (names) =>
			withToken((token) =>
				Do(async ($): Promise<DriveListing> => {
					const at = names.join('/');
					if (names.length === 0) {
						return {path: '', files: PLACES.map(placeFile)};
					}
					const {found, missing, inside} = $(await walk(token, names));
					if (missing.length > 0) {
						return $(Err(ApiErr.notFound('folder', at, `There is no ${at} in this drive.`)));
					}
					if (inside === null || found.at(-1)?.folder !== true) {
						return $(Err(ApiErr.validationError(`${at} is a file: pap files pull reads it.`)));
					}
					const {files, more} = $(await listInside(token, inside, at));
					return {path: at, files, ...(more ? {more} : {})};
				}),
			),

		pull: (asked) =>
			withToken((token) =>
				Do(async ($) => {
					const fileId = $(requirePresent(fileIdOf(asked.id), ApiErr.notFound('file', asked.id, `There is no file ${asked.id} in this drive.`)));
					const file = $(await getFileState(token, fileId));
					if (file.mimeType === MIME_TYPES.folder) {
						return $(Err(ApiErr.validationError(`${file.name} is a folder: pap files ls lists it.`)));
					}
					// Found only where it is asked for: a blob needs no path.
					const path = asked.path ?? '';
					if (isGoogleType(file.mimeType)) {
						return $(await pullExport(token, file, asked, path));
					}
					return $(await pullBytes(token, file, asked, path));
				}),
			),

		check: (target, file) => checkDriveUpload(at, target, file),

		upload: (target, blob) => uploadToDrive(at, target, blob),
	};
}
