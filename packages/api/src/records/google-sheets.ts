import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {fileIdOf} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {addSheet, appendDimension, columnIndex, columnLetters, deleteDimension, deleteSheet, getSheets, insertDimension, type Dimension, type Sheet} from '../connections/google/sheets-api';
import {readParams, type NativeToolRunner} from '../native/tool';
import {changeDriveFile, type DriveChangeEntry, type DriveEditor, runEditor} from './google-history';

/**
 * A spreadsheet's structure, changed through the Sheets API: `sheets_rows` inserts or deletes rows
 * or columns of a tab, and `sheets_tabs` adds a tab or deletes one. Each goes through the
 * spreadsheet's history (google-history.ts), logged as an edit with Drive's revisions before and
 * after, with no exact undo, as a range written has: what they take away is given back from the
 * copy kept before the task's first change to the spreadsheet (files_restore).
 */

function requireSpreadsheet(given: string): Result<string, ApiError> {
	return requirePresent(fileIdOf(given), ApiErr.validationError('Say which spreadsheet as spreadsheet: its id, as files_list gives it, or its link'));
}

const NO_UNDO = 'It has no exact undo: files_versions lists the version kept from before this task’s first change to the spreadsheet, which files_restore gives back, with what this took away.';

// A tab by its title, or the tabs there are.
function requireTab(sheets: Sheet[], title: string): Result<Sheet, ApiError> {
	const tab = sheets.find((sheet) => sheet.title === title);
	if (!tab) {
		return Err(ApiErr.validationError(`The spreadsheet has no tab “${title}”; its tabs are ${sheets.map((sheet) => `“${sheet.title}”`).join(', ')}`));
	}
	return Ok(tab);
}

// A structural change made through the spreadsheet's history, logged as an edit; answers what it
// answered, and the spreadsheet's name.
function changeSpreadsheet<T>(editor: DriveEditor, spreadsheetId: string, write: () => Promise<Result<T, ApiError>>): Promise<Result<{name: string; done: T}, ApiError>> {
	const entry: DriveChangeEntry = {kind: 'edit'};
	return changeDriveFile(editor, spreadsheetId, {content: true}, async (change) => (await write()).map((done) => ({done: {name: change.name, done}, entry})));
}

// ---- Rows and columns --------------------------------------------------------------------------

const placeSchema = z.strictObject({start: z.union([z.number().int().min(1), z.string().regex(/^\d{1,7}$|^[A-Za-z]{1,3}$/)]), count: z.number().int().min(1)});

const rowsSchema = z.object({
	spreadsheet: z.string().min(1),
	tab: z.string().min(1),
	insert: placeSchema.optional(),
	delete: placeSchema.optional(),
	dimension: z.enum(['rows', 'columns']).optional(),
});

type Place = z.infer<typeof placeSchema>;

type Axis = 'rows' | 'columns';

// Where rows or columns start, counting from 1: a row's number, or a column's letters or number.
function startOf(axis: Axis, start: Place['start']): Result<number, ApiError> {
	if (typeof start === 'number' || /^\d+$/.test(start)) {
		return Ok(Number(start));
	}
	if (axis === 'rows') {
		return Err(ApiErr.validationError(`A row starts at its number, from 1, not “${start}”; give dimension columns for columns`));
	}
	return Ok(columnIndex(start.toUpperCase()) + 1);
}

// Rows or columns from `start` to `last`, counting from 1, as Sheets names them: "rows 5 to 7", "column C".
function spanText(axis: Axis, start: number, count: number): string {
	const name = (at: number) => (axis === 'rows' ? String(at) : columnLetters(at - 1));
	const last = start + count - 1;
	if (count === 1) {
		return `${axis === 'rows' ? 'row' : 'column'} ${name(start)}`;
	}
	return `${axis} ${name(start)} to ${name(last)}`;
}

/** Rows or columns inserted or deleted, as asked, once checked against the tab's grid. */
type Structural = {axis: Axis; insert: boolean; start: number; count: number};

function insertOrDelete(params: z.infer<typeof rowsSchema>): Result<Structural, ApiError> {
	const axis = params.dimension ?? 'rows';
	const place = params.insert ?? params.delete;
	if (place === undefined || (params.insert !== undefined && params.delete !== undefined)) {
		return Err(ApiErr.validationError('sheets_rows takes one of insert or delete, each a start and a count'));
	}
	return startOf(axis, place.start).map((start) => ({axis, insert: params.insert !== undefined, start, count: place.count}));
}

function checkGrid(tab: Sheet, change: Structural): Result<void, ApiError> {
	const size = change.axis === 'rows' ? tab.rowCount : tab.columnCount;
	const last = change.start + change.count - 1;
	if (change.insert && change.start > size + 1) {
		return Err(ApiErr.validationError(`“${tab.title}” has ${size} ${change.axis}: insert at ${change.axis === 'rows' ? size + 1 : columnLetters(size)} at most, after its last`));
	}
	if (!change.insert && last > size) {
		return Err(ApiErr.validationError(`“${tab.title}” has ${size} ${change.axis}, so ${spanText(change.axis, change.start, change.count)} can’t be deleted`));
	}
	return Ok(undefined);
}

// The rows or columns inserted, at the end of the tab's grid as Sheets adds them there, or deleted.
function writeStructural(token: string, spreadsheetId: string, tab: Sheet, change: Structural): Promise<Result<void, ApiError>> {
	const size = change.axis === 'rows' ? tab.rowCount : tab.columnCount;
	const dimension: Dimension = {sheetId: tab.sheetId, dimension: change.axis === 'rows' ? 'ROWS' : 'COLUMNS', start: change.start - 1, count: change.count};
	if (!change.insert) {
		return deleteDimension(token, spreadsheetId, dimension);
	}
	if (change.start === size + 1) {
		return appendDimension(token, spreadsheetId, dimension);
	}
	return insertDimension(token, spreadsheetId, dimension);
}

function rowsDone(tab: Sheet, spreadsheet: string, change: Structural): string {
	const span = spanText(change.axis, change.start, change.count);
	if (change.insert) {
		const what = change.count === 1 ? `an empty ${change.axis.slice(0, -1)}` : `${change.count} empty ${change.axis}`;
		const moved = change.axis === 'rows' ? 'down' : 'right';
		return `Inserted ${what} into “${tab.title}” in “${spreadsheet}”, now ${span}; the ${change.axis} from there on moved ${moved}. ${NO_UNDO}`;
	}
	const [they, them, their] = change.count === 1 ? ['it', 'it', 'its'] : ['they', 'them', 'their'];
	const moved = change.axis === 'rows' ? `below ${them} moved up` : `to ${their} right moved left`;
	return `Deleted ${span} of “${tab.title}” in “${spreadsheet}”, with what ${they} held; the ${change.axis} ${moved}. ${NO_UNDO}`;
}

// The tab found by its title, the change checked against its grid, and made.
function changeRows(editor: DriveEditor, spreadsheetId: string, title: string, change: Structural): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const tab = $(requireTab($(await getSheets(editor.token, spreadsheetId)), title));
		$(checkGrid(tab, change));
		const {name} = $(await changeSpreadsheet(editor, spreadsheetId, () => writeStructural(editor.token, spreadsheetId, tab, change)));
		return rowsDone(tab, name, change);
	});
}

/** `sheets_rows`: rows or columns of a tab inserted or deleted. */
export const runSheetsRows: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const params = $(readParams(rowsSchema, 'sheets_rows', 'spreadsheet, tab, one of insert or delete, each a start and a count, and dimension', run.params));
		const spreadsheetId = $(requireSpreadsheet(params.spreadsheet));
		const change = $(insertOrDelete(params));
		return $(await callGoogle(run.connection, (token) => changeRows(runEditor(run, token), spreadsheetId, params.tab, change)));
	});

// ---- Tabs ----------------------------------------------------------------------------------------

// Sheets' longest tab title.
const MAX_TITLE = 100;

const tabsSchema = z.object({spreadsheet: z.string().min(1), add: z.string().trim().min(1).max(MAX_TITLE).optional(), delete: z.string().min(1).optional()});

function addTab(editor: DriveEditor, spreadsheetId: string, title: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const sheets = $(await getSheets(editor.token, spreadsheetId));
		if (sheets.some((sheet) => sheet.title.toLowerCase() === title.toLowerCase())) {
			return $(Err(ApiErr.conflict(`The spreadsheet has a tab “${title}” already: give the new one another name`)));
		}
		const {name, done} = $(await changeSpreadsheet(editor, spreadsheetId, () => addSheet(editor.token, spreadsheetId, title)));
		return `Added the tab “${done.title}” to “${name}”, after its other tabs, with ${done.rowCount} rows and ${done.columnCount} columns.`;
	});
}

function deleteTab(editor: DriveEditor, spreadsheetId: string, title: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const sheets = $(await getSheets(editor.token, spreadsheetId));
		const tab = $(requireTab(sheets, title));
		if (sheets.length === 1) {
			return $(Err(ApiErr.validationError(`“${title}” is the spreadsheet’s only tab, and a spreadsheet keeps one: add another first, or move the file to Trash`)));
		}
		const {name} = $(await changeSpreadsheet(editor, spreadsheetId, () => deleteSheet(editor.token, spreadsheetId, tab.sheetId)));
		return `Deleted the tab “${title}” from “${name}”, with everything on it. ${NO_UNDO}`;
	});
}

/** `sheets_tabs`: a tab added to a spreadsheet, or one deleted. */
export const runSheetsTabs: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const params = $(readParams(tabsSchema, 'sheets_tabs', 'spreadsheet, and one of add or delete, a tab’s title', run.params));
		const spreadsheetId = $(requireSpreadsheet(params.spreadsheet));
		const {add, delete: remove} = params;
		if ((add === undefined) === (remove === undefined)) {
			return $(Err(ApiErr.validationError('sheets_tabs takes one of add or delete, a tab’s title')));
		}
		return $(
			await callGoogle(run.connection, (token) => {
				const editor = runEditor(run, token);
				return add === undefined ? deleteTab(editor, spreadsheetId, remove ?? '') : addTab(editor, spreadsheetId, add);
			}),
		);
	});
