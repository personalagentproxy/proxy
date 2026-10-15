import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {
	createFile,
	DRIVE_ID,
	driveQuoted,
	exportFile,
	getFile,
	getFileParents,
	getMyDriveId,
	getSharedDrive,
	listFiles,
	listSharedDrives,
	MIME_TYPES,
	PAGE_SIZE,
	replaceContent,
	updateFile,
	type DriveFile,
	type FileParents,
	type SharedDrive,
} from '../connections/google/drive-api';
import {callGoogle, TOO_LARGE_TO_READ} from '../connections/google/google-client';
import {appendRow, cellRange, columnLetters, getRanges, getSheets, renameSheet, rowsRange, updateCells, type Sheet} from '../connections/google/sheets-api';
import type {CommandRunner, Crumb, DataRecord, ListQuery, RecordPage, RecordTarget, RecordValues} from './connector';
import {readValueLines, valueLines} from './value-lines';

/**
 * A Google account's Drive as the `files` collection: a tree, fetched live. At the top are four
 * places, My Drive, Shared with me, Shared drives and Recent; inside them, and inside folders and
 * shared drives, are files, folders first, 50 to a page with Drive's own page token. A search is
 * Drive's, in names and contents, anywhere or inside the folder or place opened.
 *
 * A document opens as Markdown and a presentation as text, as Drive exports them, up to Drive's
 * 10 MB; a spreadsheet opens into its tabs, and a tab into its rows, 50 to a page, each row's values
 * as "Header: value" lines, the headers from the tab's first row. Other files open as what Drive
 * knows of them, with a link.
 *
 * Folders, documents and spreadsheets are made inside a folder, My Drive or a shared drive: a
 * document from Markdown and a spreadsheet from CSV, which Drive converts as it uploads them. A row
 * is made inside a tab, its "Header: value" lines put under the headers. Any file can be renamed,
 * and a tab; a document's content is replaced whole by uploading Markdown again, which drops its
 * comments and suggestions; a row changes only in the cells written differently. A presentation's
 * and a spreadsheet's content are only read. Files go to Trash, never deleted for good.
 */

// Each with where Drive shows it: `https://drive.google.com/drive/<path>`.
const PLACES = [
	{id: 'root', name: 'My Drive', path: 'my-drive'},
	{id: 'shared-with-me', name: 'Shared with me', path: 'shared-with-me'},
	{id: 'shared-drives', name: 'Shared drives', path: 'shared-drives'},
	{id: 'recent', name: 'Recent', path: 'recent'},
] as const;

type Place = (typeof PLACES)[number];

const [MY_DRIVE, SHARED_WITH_ME, SHARED_DRIVES] = PLACES;

// Folders first, then the last changed, as Drive shows a folder.
const FOLDER_ORDER = 'folder,modifiedTime desc';

// How far up the folders a trail goes before it stops looking.
const MAX_DEPTH = 10;

// Rows looked through past a page of rows that came back short, for the next one holding anything.
const LOOKAHEAD_ROWS = 1000;

/**
 * What a record id names: a place, a shared drive (`drive-<id>`), a Drive file by its own id, a
 * spreadsheet's tab (`sheet-<file>-<tab>`), or a row of one (`row-<file>-<tab>-<row>`, its number
 * in the tab, from 2 since row 1 holds the headers).
 */
type FileRef =
	| {kind: 'place'; place: Place}
	| {kind: 'drive'; driveId: string}
	| {kind: 'file'; fileId: string}
	| {kind: 'sheet'; fileId: string; sheetId: number}
	| {kind: 'row'; fileId: string; sheetId: number; row: number};

function parseRef(recordId: string): FileRef | null {
	const place = PLACES.find((candidate) => candidate.id === recordId);
	if (place) {
		return {kind: 'place', place};
	}
	const drive = /^drive-([A-Za-z0-9_-]+)$/.exec(recordId);
	if (drive?.[1]) {
		return {kind: 'drive', driveId: drive[1]};
	}
	const sheet = /^sheet-([A-Za-z0-9_-]+)-(\d{1,12})$/.exec(recordId);
	if (sheet?.[1] && sheet[2]) {
		return {kind: 'sheet', fileId: sheet[1], sheetId: Number(sheet[2])};
	}
	const row = /^row-([A-Za-z0-9_-]+)-(\d{1,12})-(\d{1,7})$/.exec(recordId);
	if (row?.[1] && row[2] && row[3] && Number(row[3]) >= 2) {
		return {kind: 'row', fileId: row[1], sheetId: Number(row[2]), row: Number(row[3])};
	}
	if (DRIVE_ID.test(recordId)) {
		return {kind: 'file', fileId: recordId};
	}
	return null;
}

function requireRef(recordId: string): Result<FileRef, ApiError> {
	const ref = parseRef(recordId);
	if (!ref) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(ref);
}

function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

/** One request's way into Drive: the access token, and My Drive's own id, asked for once at most. */
type Drive = {token: string; myDriveId: () => Promise<Result<string, ApiError>>};

function withDrive<T>(target: RecordTarget, run: (drive: Drive) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return callGoogle(target.connection, (token) => {
		let myDriveId: Promise<Result<string, ApiError>> | null = null;
		return run({token, myDriveId: () => (myDriveId ??= getMyDriveId(token))});
	});
}

export function kindOf(mimeType: string): string {
	if (mimeType === MIME_TYPES.folder) {
		return 'Folder';
	}
	if (mimeType === MIME_TYPES.document) {
		return 'Document';
	}
	if (mimeType === MIME_TYPES.spreadsheet) {
		return 'Spreadsheet';
	}
	if (mimeType === MIME_TYPES.presentation) {
		return 'Presentation';
	}
	// Shortcuts too: they open as themselves, not as what they point at.
	return 'File';
}

function fileValues(file: DriveFile): Record<string, string> {
	const owner = file.owners?.[0];
	return {name: file.name, kind: kindOf(file.mimeType), modified: file.modifiedTime ?? '', owner: owner?.displayName ?? owner?.emailAddress ?? ''};
}

// The file in Drive, or in Docs, Sheets or Slides, as Drive links it; `at` is where in it, a tab or a row.
function fileUrl(file: DriveFile, at = ''): Pick<DataRecord, 'url'> {
	return file.webViewLink ? {url: `${file.webViewLink}${at}`} : {};
}

function fileRecord(file: DriveFile): DataRecord {
	const kind = kindOf(file.mimeType);
	return {id: file.id, values: fileValues(file), updatedAt: file.modifiedTime ?? '', ...fileUrl(file), ...(kind === 'Folder' || kind === 'Spreadsheet' ? {hasChildren: true} : {})};
}

function placeRecord(place: Place): DataRecord {
	return {id: place.id, values: {name: place.name, kind: 'Place'}, updatedAt: '', url: `https://drive.google.com/drive/${place.path}`, hasChildren: true};
}

function driveRecord(drive: SharedDrive): DataRecord {
	return {id: `drive-${drive.id}`, values: {name: drive.name, kind: 'Shared drive'}, updatedAt: '', url: `https://drive.google.com/drive/folders/${drive.id}`, hasChildren: true};
}

function sheetId(file: DriveFile, sheet: Sheet): string {
	return `sheet-${file.id}-${sheet.sheetId}`;
}

// "Sheet1: 120 rows, 8 columns", the tab's grid, empty cells included.
function sheetSize(sheet: Sheet): string {
	return `${sheet.rowCount} rows, ${sheet.columnCount} columns`;
}

function sheetRecord(file: DriveFile, sheet: Sheet): DataRecord {
	return {
		id: sheetId(file, sheet),
		values: {...fileValues(file), name: sheet.title, kind: 'Sheet', content: sheetSize(sheet)},
		updatedAt: file.modifiedTime ?? '',
		...fileUrl(file, `#gid=${sheet.sheetId}`),
		hasChildren: true,
	};
}

// The last column a row is read and written in: ZZ, as `rowsRange` reads.
const MAX_COLUMNS = 702;

// What a row's values go by: the tab's header, or, for a column without one, its letter.
function columnName(headers: string[], column: number): string {
	return headers[column] || `Column ${columnLetters(column)}`;
}

/**
 * Every column of a tab a row's lines can name, as far as its grid or its headers go, each name
 * once, so a line is read back into the column it was written from: a header repeated, or the
 * same as a column without one goes by, goes on with its column's letter, "Status (E)".
 */
function columnNames(headers: string[], sheet: Sheet): string[] {
	const count = Math.min(Math.max(headers.length, sheet.columnCount), MAX_COLUMNS);
	const names: string[] = [];
	const taken = new Set<string>();
	for (let column = 0; column < count; column += 1) {
		let name = columnName(headers, column);
		while (taken.has(name)) {
			name = `${name} (${columnLetters(column)})`;
		}
		taken.add(name);
		names.push(name);
	}
	return names;
}

// A row's values under the tab's headers; a column without one goes by its letter.
function rowRecord(file: DriveFile, sheet: Sheet, headers: string[], row: number, cells: string[]): DataRecord {
	const names = columnNames(headers, {...sheet, columnCount: Math.max(sheet.columnCount, cells.length)});
	const content = valueLines(cells.map((cell, column): [string, string] => [names[column] ?? columnName(headers, column), cell]));
	return {
		id: `row-${file.id}-${sheet.sheetId}-${row}`,
		// Rows have no time of their own; the spreadsheet's is when anything in it changed.
		values: {...fileValues(file), name: cells[0] || `Row ${row}`, kind: 'Row', content},
		updatedAt: file.modifiedTime ?? '',
		...fileUrl(file, `#gid=${sheet.sheetId}&range=A${row}`),
	};
}

function isBlank(cells: string[]): boolean {
	return cells.every((cell) => cell === '');
}

/** A spreadsheet and its tab, the tab found by its id among the spreadsheet's. */
function getSheet(drive: Drive, fileId: string, id: number): Promise<Result<{file: DriveFile; sheet: Sheet}, ApiError>> {
	return Do(async ($) => {
		const [file, sheets] = await Promise.all([getFile(drive.token, fileId), getSheets(drive.token, fileId)]);
		const sheet = $(sheets).find((candidate) => candidate.sheetId === id);
		if (!sheet) {
			return $(Err(ApiErr.notFound('sheet')));
		}
		return {file: $(file), sheet};
	});
}

/**
 * The records above a file, from the top: where it is, then its folders, the nearest last. Drive
 * gives each file the folder it is in; walking up stops at My Drive, at the top of a shared drive
 * (whose folder has the drive's own id), or where the account can't see further up, as with a
 * folder someone shared, or a shared drive it isn't a member of, which is then under Shared with me. Past 10 folders it stops looking, and
 * the trail starts at the 10th.
 */
function crumbsAbove(drive: Drive, file: FileParents): Promise<Result<Crumb[], ApiError>> {
	return Do(async ($) => {
		const sharedDriveId = file.driveId;
		const myDriveId = sharedDriveId ? null : $(await drive.myDriveId());
		const folders: Crumb[] = [];
		let parentId = file.parents?.[0];
		for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
			if (parentId === undefined) {
				return [{id: SHARED_WITH_ME.id, title: SHARED_WITH_ME.name}, ...folders];
			}
			if (parentId === myDriveId) {
				return [{id: MY_DRIVE.id, title: MY_DRIVE.name}, ...folders];
			}
			if (parentId === sharedDriveId) {
				// A shared drive the account isn't a member of, which someone shared a file from.
				const shared = await getSharedDrive(drive.token, sharedDriveId);
				if (shared.isErr() && shared.error.kind === 'not_found') {
					return [{id: SHARED_WITH_ME.id, title: SHARED_WITH_ME.name}, ...folders];
				}
				const {id, name} = $(shared);
				return [{id: SHARED_DRIVES.id, title: SHARED_DRIVES.name}, {id: `drive-${id}`, title: name}, ...folders];
			}
			const parent = await getFileParents(drive.token, parentId);
			if (parent.isErr() && parent.error.kind === 'not_found') {
				return [{id: SHARED_WITH_ME.id, title: SHARED_WITH_ME.name}, ...folders];
			}
			const {id, name, parents} = $(parent);
			folders.unshift({id, title: name});
			parentId = parents?.[0];
		}
		return folders;
	});
}

/** The trail to a file: the records above it, then the file. */
function trailTo(drive: Drive, file: DriveFile): Promise<Result<Crumb[], ApiError>> {
	return Do(async ($) => [...$(await crumbsAbove(drive, file)), {id: file.id, title: file.name}]);
}

/**
 * One page of files matching `terms`, in `order`, or, searched, in the order Drive finds best,
 * since Drive sorts no full-text search. Trashed files are never listed.
 */
function filesPage(drive: Drive, query: ListQuery, args: {terms: string[]; order: string | null; params?: Record<string, string>}): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const search = query.search === null ? [] : [`fullText contains ${driveQuoted(query.search)}`];
		const q = [...search, ...args.terms, 'trashed=false'].join(' and ');
		const order: Record<string, string> = query.search === null && args.order ? {orderBy: args.order} : {};
		const page = $(await listFiles(drive.token, q, {...order, ...args.params}, query.page));
		return {records: page.items.map(fileRecord), nextPage: page.nextPage};
	});
}

function inParents(id: string): string {
	return `${driveQuoted(id)} in parents`;
}

function listPlace(drive: Drive, place: Place, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const trail = [{id: place.id, title: place.name}];
		if (place.id === 'root') {
			return {...$(await filesPage(drive, query, {terms: [inParents('root')], order: FOLDER_ORDER})), trail};
		}
		if (place.id === 'shared-with-me') {
			return {...$(await filesPage(drive, query, {terms: ['sharedWithMe=true'], order: 'sharedWithMeTime desc'})), trail};
		}
		if (place.id === 'recent') {
			// As Drive's own Recent: files the account opened, last first, shared drives' too.
			const terms = ["viewedByMeTime > '1970-01-01T00:00:00'", `mimeType != '${MIME_TYPES.folder}'`];
			return {...$(await filesPage(drive, query, {terms, order: 'viewedByMeTime desc', params: {corpora: 'allDrives'}})), trail};
		}
		// Shared drives are searched by their names.
		const drives = $(await listSharedDrives(drive.token, query.search, query.page));
		return {records: drives.items.map(driveRecord), nextPage: drives.nextPage, trail};
	});
}

function listSharedDrive(drive: Drive, driveId: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const [shared, page] = await Promise.all([getSharedDrive(drive.token, driveId), filesPage(drive, query, {terms: [inParents(driveId)], order: FOLDER_ORDER, params: {corpora: 'drive', driveId}})]);
		const {id, name} = $(shared);
		return {
			...$(page),
			trail: [
				{id: SHARED_DRIVES.id, title: SHARED_DRIVES.name},
				{id: `drive-${id}`, title: name},
			],
		};
	});
}

/** A tab's rows, 50 to a page, the page token the number of the row it starts at. */
function listRows(drive: Drive, ref: {fileId: string; sheetId: number}, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		if (query.page !== null && !/^\d{1,7}$/.test(query.page)) {
			return $(Err(ApiErr.validationError(`Not a page of rows: ${query.page}`)));
		}
		const from = Math.max(Number(query.page ?? 2), 2);
		const to = from + PAGE_SIZE - 1;
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		const tab = {id: sheetId(file, sheet), title: sheet.title};
		// Sheets refuses a range wholly outside the grid, so a page past the tab's last row is empty without asking.
		if (from > sheet.rowCount) {
			return {records: [], nextPage: null, trail: [...$(await trailTo(drive, file)), tab]};
		}
		const [ranges, trail] = await Promise.all([getRanges(drive.token, file.id, [rowsRange(sheet.title, 1, 1), rowsRange(sheet.title, from, to)]), trailTo(drive, file)]);
		const [[headers = []] = [], rows = []] = $(ranges);
		const records = rows.flatMap((cells, index) => (isBlank(cells) ? [] : [rowRecord(file, sheet, headers, from + index, cells)]));
		const nextPage = $(await nextRowsPage(drive, file.id, sheet, to, rows.length));
		return {records, nextPage, trail: [...$(trail), tab]};
	});
}

/**
 * Where the page after rows up to `to` starts. Sheets leaves out the empty rows at the end of each
 * range asked for, so a page short of 50 may only have ended in empty rows: the rows after it are
 * looked through for the next that isn't, 1000 at a time.
 */
function nextRowsPage(drive: Drive, fileId: string, sheet: Sheet, to: number, read: number): Promise<Result<string | null, ApiError>> {
	return Do(async ($) => {
		if (to >= sheet.rowCount) {
			return null;
		}
		if (read === PAGE_SIZE) {
			return String(to + 1);
		}
		const end = Math.min(sheet.rowCount, to + LOOKAHEAD_ROWS);
		const [after = []] = $(await getRanges(drive.token, fileId, [rowsRange(sheet.title, to + 1, end)]));
		const next = after.findIndex((cells) => !isBlank(cells));
		if (next !== -1) {
			return String(to + 1 + next);
		}
		return end < sheet.rowCount ? String(end + 1) : null;
	});
}

const NOT_SEARCHED = 'Only Drive, its folders and shared drives are searched, not a spreadsheet’s tabs or rows';

// What a list opened in a file shows: a folder's files, a spreadsheet's tabs; other files hold nothing.
function listFile(drive: Drive, fileId: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const file = $(await getFile(drive.token, fileId));
		const kind = kindOf(file.mimeType);
		if (kind === 'Spreadsheet' && query.search !== null) {
			return $(Err(ApiErr.validationError(NOT_SEARCHED)));
		}
		const trail = $(await trailTo(drive, file));
		if (kind === 'Folder') {
			const params: Record<string, string> = file.driveId ? {corpora: 'drive', driveId: file.driveId} : {};
			return {...$(await filesPage(drive, query, {terms: [inParents(file.id)], order: FOLDER_ORDER, params})), trail};
		}
		if (kind === 'Spreadsheet') {
			const sheets = $(await getSheets(drive.token, file.id));
			return {records: sheets.map((sheet) => sheetRecord(file, sheet)), nextPage: null, trail};
		}
		return {records: [], nextPage: null, trail};
	});
}

function listInside(drive: Drive, ref: FileRef, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	if (ref.kind === 'place') {
		return listPlace(drive, ref.place, query);
	}
	if (ref.kind === 'drive') {
		return listSharedDrive(drive, ref.driveId, query);
	}
	if (ref.kind === 'file') {
		return listFile(drive, ref.fileId, query);
	}
	if (query.search !== null) {
		return Promise.resolve(Err(ApiErr.validationError(NOT_SEARCHED)));
	}
	if (ref.kind === 'sheet') {
		return listRows(drive, ref, query);
	}
	// A row holds nothing.
	return Do(async ($) => {
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		const trail = [...$(await trailTo(drive, file)), {id: sheetId(file, sheet), title: sheet.title}, {id: `row-${file.id}-${sheet.sheetId}-${ref.row}`, title: `Row ${ref.row}`}];
		return {records: [], nextPage: null, trail};
	});
}

export function listFilesTree(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return withDrive(target, (drive) =>
		Do(async ($) => {
			if (query.parent !== null) {
				const ref = $(requireRef(query.parent));
				return $((await listInside(drive, ref, query)).mapErr(notFoundAs(query.parent)));
			}
			if (query.search !== null) {
				return $(await filesPage(drive, query, {terms: [], order: null, params: {corpora: 'allDrives'}}));
			}
			return {records: PLACES.map(placeRecord), nextPage: null};
		}),
	);
}

// A file's content as Google exports it; one past Google's export limit says so in its place, so
// the file can still be renamed or moved to Trash.
async function exported(drive: Drive, fileId: string, type: string): Promise<Result<string, ApiError>> {
	const content = await exportFile(drive.token, fileId, type);
	if (content.isErr() && content.error.kind === 'validation_error' && content.error.message === TOO_LARGE_TO_READ) {
		return Ok(TOO_LARGE_TO_READ);
	}
	return content;
}

// A document as Markdown, a presentation as text, a spreadsheet's tabs one a line; other files have none.
function contentOf(drive: Drive, file: DriveFile): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const kind = kindOf(file.mimeType);
		if (kind === 'Document') {
			return $(await exported(drive, file.id, 'text/markdown'));
		}
		if (kind === 'Presentation') {
			return $(await exported(drive, file.id, 'text/plain'));
		}
		if (kind === 'Spreadsheet') {
			const sheets = $(await getSheets(drive.token, file.id));
			return sheets.map((sheet) => `${sheet.title}: ${sheetSize(sheet)}`).join('\n');
		}
		return '';
	});
}

function getRef(drive: Drive, ref: FileRef): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		if (ref.kind === 'place') {
			return placeRecord(ref.place);
		}
		if (ref.kind === 'drive') {
			return driveRecord($(await getSharedDrive(drive.token, ref.driveId)));
		}
		if (ref.kind === 'file') {
			const file = $(await getFile(drive.token, ref.fileId));
			const record = fileRecord(file);
			return {...record, values: {...record.values, content: $(await contentOf(drive, file))}};
		}
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		if (ref.kind === 'sheet') {
			return sheetRecord(file, sheet);
		}
		// A row past the tab's last is not there, and Sheets refuses a range outside the grid rather than answering it empty.
		if (ref.row > sheet.rowCount) {
			return $(Err(ApiErr.notFound('row')));
		}
		const [[headers = []] = [], [cells = []] = []] = $(await getRanges(drive.token, file.id, [rowsRange(sheet.title, 1, 1), rowsRange(sheet.title, ref.row, ref.row)]));
		if (isBlank(cells)) {
			return $(Err(ApiErr.notFound('row')));
		}
		return rowRecord(file, sheet, headers, ref.row, cells);
	});
}

export function getFilesRecord(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return withDrive(target, (drive) =>
		Do(async ($) => {
			const ref = $(requireRef(recordId));
			return $((await getRef(drive, ref)).mapErr(notFoundAs(recordId)));
		}),
	);
}

// ---- Writing --------------------------------------------------------------------------------

// What a new file can be, the Google type it is made as, and what its content is uploaded as.
const MADE: Partial<Record<string, {mimeType: string; upload: string | null}>> = {
	Folder: {mimeType: MIME_TYPES.folder, upload: null},
	Document: {mimeType: MIME_TYPES.document, upload: 'text/markdown'},
	Spreadsheet: {mimeType: MIME_TYPES.spreadsheet, upload: 'text/csv'},
};

const KINDS_MADE = 'Folder, Document or Spreadsheet';

function refuse(message: string): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError(message)));
}

// A folder, document or spreadsheet, made in the folder with Drive's id `parentId`, answered as
// opening it would.
function makeFile(drive: Drive, parentId: string, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const kind = values.kind ?? '';
		const made = MADE[kind];
		if (!made) {
			return $(Err(ApiErr.validationError(`Say what to make as kind: ${KINDS_MADE}`)));
		}
		const name = (values.name ?? '').trim();
		if (name === '') {
			return $(Err(ApiErr.validationError(`A new ${kind.toLowerCase()} needs a name`)));
		}
		const content = values.content ?? '';
		if (made.upload === null && content.trim() !== '') {
			return $(Err(ApiErr.validationError('A folder has no content')));
		}
		const upload = made.upload === null || content === '' ? null : {type: made.upload, body: content};
		const file = $(await createFile(drive.token, {name, mimeType: made.mimeType, parent: parentId}, upload));
		return $(await getRef(drive, {kind: 'file', fileId: file.id}));
	});
}

// The headers of a tab's first row, and every column its rows' lines can name.
function headersOf(drive: Drive, file: DriveFile, sheet: Sheet): Promise<Result<{headers: string[]; names: string[]}, ApiError>> {
	return Do(async ($) => {
		const [[headers = []] = []] = $(await getRanges(drive.token, file.id, [rowsRange(sheet.title, 1, 1)]));
		return {headers, names: columnNames(headers, sheet)};
	});
}

// A new row at the end of a tab, its lines put under the headers they name.
function addRow(drive: Drive, ref: {fileId: string; sheetId: number}, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		if ((values.kind ?? '') !== '' && values.kind !== 'Row') {
			return $(Err(ApiErr.validationError('A tab holds rows: leave kind out, or make it Row')));
		}
		if ((values.name ?? '') !== '') {
			return $(Err(ApiErr.validationError('A row’s name is its first value: write it in content')));
		}
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		const {headers, names} = $(await headersOf(drive, file, sheet));
		if (isBlank(headers)) {
			return $(Err(ApiErr.validationError(`“${sheet.title}” has no headers in its first row; write a range instead`)));
		}
		const written = $(readValueLines(values.content ?? '', names));
		const cells = names.map((name) => written[name] ?? '');
		const last = cells.findLastIndex((cell) => cell !== '');
		if (last === -1) {
			return $(Err(ApiErr.validationError('Write the row’s values in content, one "Header: value" a line')));
		}
		const row = $(await appendRow(drive.token, file.id, sheet.title, cells.slice(0, last + 1)));
		return $(await getRef(drive, {kind: 'row', fileId: file.id, sheetId: sheet.sheetId, row}));
	});
}

function createIn(drive: Drive, ref: FileRef, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	if (ref.kind === 'place') {
		if (ref.place.id !== MY_DRIVE.id) {
			return refuse(`Nothing can be made in ${ref.place.name}: make it in a folder, My Drive or a shared drive`);
		}
		return makeFile(drive, MY_DRIVE.id, values);
	}
	if (ref.kind === 'drive') {
		return makeFile(drive, ref.driveId, values);
	}
	if (ref.kind === 'sheet') {
		return addRow(drive, ref, values);
	}
	if (ref.kind === 'row') {
		return refuse('A row holds nothing: add rows to its tab');
	}
	return Do(async ($) => {
		const file = $(await getFile(drive.token, ref.fileId));
		const kind = kindOf(file.mimeType);
		if (kind === 'Spreadsheet') {
			return $(Err(ApiErr.validationError('Rows go in one of the spreadsheet’s tabs: open it and pick one as parent')));
		}
		if (kind !== 'Folder') {
			return $(Err(ApiErr.validationError(`A ${kind.toLowerCase()} holds nothing: make it in a folder`)));
		}
		return $(await makeFile(drive, file.id, values));
	});
}

/**
 * A new file inside `parent`, My Drive when none is given: a folder, document or spreadsheet in a
 * folder, My Drive or a shared drive, or a row in a tab.
 */
export function createFilesRecord(target: RecordTarget, values: RecordValues, parent: string | null): Promise<Result<DataRecord, ApiError>> {
	return withDrive(target, (drive) =>
		Do(async ($) => {
			const where = parent ?? MY_DRIVE.id;
			const ref = $(requireRef(where));
			return $((await createIn(drive, ref, values)).mapErr(notFoundAs(where)));
		}),
	);
}

// A kind written differently from the record's: what a record is can't be changed.
function requireKind(current: string, written: string | undefined): Result<void, ApiError> {
	if (written === undefined || written === '' || written === current) {
		return Ok(undefined);
	}
	return Err(ApiErr.validationError(`What a file is can’t be changed: this is a ${current}`));
}

// A new name, when it is written differently: none at all is turned down.
function renamed(current: string, written: string | undefined): Result<string | null, ApiError> {
	if (written === undefined || written === current) {
		return Ok(null);
	}
	if (written.trim() === '') {
		return Err(ApiErr.validationError('A file needs a name'));
	}
	return Ok(written.trim());
}

// What can't be written into each kind of file but a document, and what can be done instead.
const CONTENT_REFUSALS: Partial<Record<string, string>> = {
	Presentation: 'A presentation’s content is only read here; its name can be changed',
	Spreadsheet: 'A spreadsheet’s content is in its tabs: change its rows, or write a range',
	Folder: 'A folder has no content; its name can be changed',
};

const OTHER_FILE_REFUSAL = 'Only a document’s content can be written here; this file’s name can be changed';

/**
 * A file renamed, and a document's content replaced, each only where it is written differently
 * from how it read, `before`, so a rename doesn't upload the content as it was read over a change
 * made since; without `before`, from how it reads now.
 */
function updateFileRef(drive: Drive, fileId: string, values: RecordValues, before: DataRecord | undefined): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const file = $(await getFile(drive.token, fileId));
		const kind = kindOf(file.mimeType);
		$(requireKind(kind, values.kind));
		const name = $(renamed(file.name, values.name));
		const content = values.content ?? null;
		const read = before?.values.content ?? $(await contentOf(drive, file));
		const replaced = content !== null && content !== read;
		if (replaced && kind !== 'Document') {
			return $(Err(ApiErr.validationError(CONTENT_REFUSALS[kind] ?? OTHER_FILE_REFUSAL)));
		}
		if (name !== null) {
			$(await updateFile(drive.token, file.id, {name}));
		}
		if (replaced) {
			$(await replaceContent(drive.token, file.id, {type: 'text/markdown', body: content}));
		}
		return $(await getRef(drive, {kind: 'file', fileId: file.id}));
	});
}

// A tab renamed; its rows are changed one by one.
function updateSheet(drive: Drive, ref: {fileId: string; sheetId: number}, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		$(requireKind('Sheet', values.kind));
		if (values.content !== undefined && values.content !== sheetSize(sheet)) {
			return $(Err(ApiErr.validationError('A tab’s content is its size: change its rows one by one, or write a range')));
		}
		const name = $(renamed(sheet.title, values.name));
		if (name === null) {
			return sheetRecord(file, sheet);
		}
		$(await renameSheet(drive.token, file.id, sheet.sheetId, name));
		return $(await getRef(drive, {kind: 'sheet', fileId: file.id, sheetId: sheet.sheetId}));
	});
}

// Only the cells of the headers written differently from how they read change; one written empty
// is cleared, and one left out stays as it is.
function updateRow(drive: Drive, ref: {fileId: string; sheetId: number; row: number}, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		$(requireKind('Row', values.kind));
		const [[headers = []] = [], [cells = []] = []] = $(await getRanges(drive.token, file.id, [rowsRange(sheet.title, 1, 1), rowsRange(sheet.title, ref.row, ref.row)]));
		if (isBlank(cells)) {
			return $(Err(ApiErr.notFound('row')));
		}
		const current = rowRecord(file, sheet, headers, ref.row, cells);
		if (values.name !== undefined && values.name !== current.values.name) {
			return $(Err(ApiErr.validationError('A row’s name is its first value: change it in content')));
		}
		const names = columnNames(headers, sheet);
		const written = $(readValueLines(values.content ?? '', names));
		const changed = names.flatMap((name, column) => {
			const value = written[name];
			return value !== undefined && value !== (cells[column] ?? '') ? [{range: cellRange(sheet.title, column, ref.row), value}] : [];
		});
		if (changed.length === 0) {
			return current;
		}
		$(await updateCells(drive.token, file.id, changed));
		return $(await getRef(drive, {kind: 'row', fileId: file.id, sheetId: sheet.sheetId, row: ref.row}));
	});
}

function updateRef(drive: Drive, ref: FileRef, values: RecordValues, before: DataRecord | undefined): Promise<Result<DataRecord, ApiError>> {
	if (ref.kind === 'place' || ref.kind === 'drive') {
		return refuse('The places at the top and shared drives aren’t changed here, only what is in them');
	}
	if (ref.kind === 'sheet') {
		return updateSheet(drive, ref, values);
	}
	if (ref.kind === 'row') {
		return updateRow(drive, ref, values);
	}
	return updateFileRef(drive, ref.fileId, values, before);
}

/** A file, tab or row changed where it is written differently, answered as opening it would. */
export function updateFilesRecord(target: RecordTarget, recordId: string, values: RecordValues, before?: DataRecord): Promise<Result<DataRecord, ApiError>> {
	return withDrive(target, (drive) =>
		Do(async ($) => {
			const ref = $(requireRef(recordId));
			return $((await updateRef(drive, ref, values, before)).mapErr(notFoundAs(recordId)));
		}),
	);
}

/** Moves a file or folder to Trash, where Drive keeps it 30 days; it leaves the tree. */
export const trashFilesRecord: CommandRunner = (target, recordId) =>
	withDrive(target, (drive) =>
		Do(async ($) => {
			const ref = $(requireRef(recordId));
			if (ref.kind !== 'file') {
				return $(Err(ApiErr.validationError('Only files and folders go to Trash, not places, shared drives, tabs or rows')));
			}
			$((await updateFile(drive.token, ref.fileId, {trashed: true})).mapErr(notFoundAs(recordId)));
			return null;
		}),
	);
