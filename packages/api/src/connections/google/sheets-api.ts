import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {SheetCell} from '@proxy/db/file-undo';

import {googleRequest, googleWrite} from './google-client';

/**
 * The Sheets v4 calls the `files` and `ranges` collections and the `sheets_` tools make, and the
 * reading of their answers: a spreadsheet's tabs, added, deleted and their rows and columns
 * inserted and deleted, and the values in ranges of one, read as Sheets shows them or as formulas
 * and written as if typed in, so a number stays a number and `=SUM(B2:B9)` is a formula.
 */

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The last column read: ZZ, the 702nd. */
const LAST_COLUMN = 'ZZ';

const sheetSchema = z.object({
	properties: z.object({
		sheetId: z.number(),
		title: z.string(),
		// The grid's size, empty cells included. A chart's tab has none.
		gridProperties: z.object({rowCount: z.number().optional(), columnCount: z.number().optional()}).optional(),
	}),
});

const spreadsheetSchema = z.object({sheets: z.array(sheetSchema).optional()});

/** One tab of a spreadsheet and the size of its grid. */
export type Sheet = {sheetId: number; title: string; rowCount: number; columnCount: number};

// Formatted values are text; a cell left empty is an empty string, and empty cells at the end of a
// row are left out.
const cellSchema = z.union([z.string(), z.number(), z.boolean()]).transform(String);

const valueRangeSchema = z.object({values: z.array(z.array(cellSchema)).optional()});

const batchSchema = z.object({valueRanges: z.array(valueRangeSchema)});

/** A spreadsheet's tabs, in order. */
export async function getSheets(accessToken: string, spreadsheetId: string): Promise<Result<Sheet[], ApiError>> {
	const url = new URL(`${SHEETS}/${spreadsheetId}`);
	url.searchParams.set('fields', 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))');
	const spreadsheet = await googleRequest(accessToken, url, spreadsheetSchema);
	return spreadsheet.map(({sheets = []}) => sheets.map(sheetOf));
}

function sheetOf({properties}: z.infer<typeof sheetSchema>): Sheet {
	return {sheetId: properties.sheetId, title: properties.title, rowCount: properties.gridProperties?.rowCount ?? 0, columnCount: properties.gridProperties?.columnCount ?? 0};
}

// A tab's title as A1 notation quotes it: `'Alex''s notes'`.
function quotedTitle(title: string): string {
	return `'${title.replace(/'/g, "''")}'`;
}

/** Rows `from` to `to` of a tab, every column, as A1 notation writes them: `'Q1 Sales'!A2:ZZ51`. */
export function rowsRange(title: string, from: number, to: number): string {
	return `${quotedTitle(title)}!A${from}:${LAST_COLUMN}${to}`;
}

/** One cell of a tab, its column counting from 0: `'Q1 Sales'!C5`. */
export function cellRange(title: string, column: number, row: number): string {
	return `${quotedTitle(title)}!${columnLetters(column)}${row}`;
}

// The values in a range, the range percent-encoded in the path, and what is done with them, such as `:append`.
function valuesUrl(spreadsheetId: string, range: string, params: Record<string, string> = {}, verb = ''): URL {
	const url = new URL(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}${verb}`);
	for (const [name, value] of Object.entries(params)) {
		url.searchParams.set(name, value);
	}
	return url;
}

// What a write answers: the range it changed, and, where asked for, the values there now.
const updatedSchema = z.object({updatedRange: z.string().optional(), updatedRows: z.number().optional(), updatedData: valueRangeSchema.optional()});

const appendSchema = z.object({updates: z.object({updatedRange: z.string()})});

/**
 * How values are read: as Sheets shows them, formatted, or each cell's formula as it was typed in,
 * `=SUM(B2:B9)`, a value that is no formula then unformatted.
 */
export type Render = 'shown' | 'formulas';

const RENDER_OPTIONS: Record<Render, string> = {shown: 'FORMATTED_VALUE', formulas: 'FORMULA'};

/** The values in a range, as `render` says, and the range itself as Sheets writes it. */
export async function getValues(accessToken: string, spreadsheetId: string, range: string, render: Render = 'shown'): Promise<Result<{range: string; values: string[][]}, ApiError>> {
	const params: Record<string, string> = render === 'shown' ? {} : {valueRenderOption: RENDER_OPTIONS[render]};
	const answer = await googleRequest(accessToken, valuesUrl(spreadsheetId, range, params), valueRangeSchema.extend({range: z.string()}));
	return answer.map((read) => ({range: read.range, values: read.values ?? []}));
}

/** Writes values into a range, as if typed in, and answers the range written and the values there now, as `render` says. */
export async function putValues(
	accessToken: string,
	spreadsheetId: string,
	range: string,
	values: string[][],
	render: Render = 'shown',
): Promise<Result<{range: string; values: string[][]}, ApiError>> {
	const url = valuesUrl(spreadsheetId, range, {valueInputOption: 'USER_ENTERED', includeValuesInResponse: 'true', responseValueRenderOption: RENDER_OPTIONS[render]});
	const answer = await googleWrite(accessToken, 'PUT', url, {range, majorDimension: 'ROWS', values}, updatedSchema);
	return answer.map((written) => ({range: written.updatedRange ?? range, values: written.updatedData?.values ?? []}));
}

// Where a write's answer says it wrote: the part after the last "!", since a tab's title can hold
// one too, as in `'a!B7'!A12:C12`.
const writtenSchema = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?\d+)?$/;

function writtenCells(range: string): Result<{column: number; row: number; lastColumn: number}, ApiError> {
	const [, first = '', row = '', last] = writtenSchema.exec(range.slice(range.lastIndexOf('!') + 1)) ?? [];
	return requirePresent(row || null, ApiErr.validationError(`Google answered a range that names no row: ${range}`)).map(() => ({
		column: columnIndex(first),
		row: Number(row),
		lastColumn: columnIndex(last ?? first),
	}));
}

/**
 * Adds a row under the last of a tab's rows that hold anything, as if typed in, and answers the
 * row's number. Sheets appends after the last block of rows in the range it is given, starting at
 * that block's first column, so the whole tab is given; where its last block doesn't start in
 * column A, the row is written again from A.
 */
export async function appendRow(accessToken: string, spreadsheetId: string, title: string, cells: string[]): Promise<Result<number, ApiError>> {
	const url = valuesUrl(spreadsheetId, quotedTitle(title), {valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS'}, ':append');
	return Do(async ($) => {
		const {updates} = $(await googleWrite(accessToken, 'POST', url, {majorDimension: 'ROWS', values: [cells]}, appendSchema));
		const written = $(writtenCells(updates.updatedRange));
		if (written.column === 0) {
			return written.row;
		}
		// The row's own cells from A, and the ones written past them emptied.
		const width = Math.max(cells.length, written.lastColumn + 1);
		const row = Array.from({length: width}, (_, column) => cells[column] ?? '');
		const range = `${quotedTitle(title)}!A${written.row}:${columnLetters(width - 1)}${written.row}`;
		$(await putValues(accessToken, spreadsheetId, range, [row]));
		return written.row;
	});
}

/** Writes each value into its own cell, as if typed in, the cells around them as they are. */
export async function updateCells(accessToken: string, spreadsheetId: string, cells: {range: string; value: string}[]): Promise<Result<void, ApiError>> {
	const data = cells.map(({range, value}) => ({range, majorDimension: 'ROWS', values: [[value]]}));
	const answer = await googleWrite(accessToken, 'POST', new URL(`${SHEETS}/${spreadsheetId}/values:batchUpdate`), {valueInputOption: 'USER_ENTERED', data}, z.object({}));
	return answer.map(() => undefined);
}

// Makes one change to a spreadsheet's structure, as `spreadsheets.batchUpdate` takes them, and answers its reply.
function updateSpreadsheet<S extends z.ZodType>(accessToken: string, spreadsheetId: string, request: object, reply: S): Promise<Result<z.infer<S>, ApiError>> {
	return googleWrite(accessToken, 'POST', new URL(`${SHEETS}/${spreadsheetId}:batchUpdate`), {requests: [request]}, reply);
}

/** Renames a tab. */
export async function renameSheet(accessToken: string, spreadsheetId: string, sheetId: number, title: string): Promise<Result<void, ApiError>> {
	const answer = await updateSpreadsheet(accessToken, spreadsheetId, {updateSheetProperties: {properties: {sheetId, title}, fields: 'title'}}, z.object({}));
	return answer.map(() => undefined);
}

/** Rows or columns of a tab, `count` of them from `start`, counting from 0. */
export type Dimension = {sheetId: number; dimension: 'ROWS' | 'COLUMNS'; start: number; count: number};

function dimensionRange({sheetId, dimension, start, count}: Dimension): object {
	return {sheetId, dimension, startIndex: start, endIndex: start + count};
}

/**
 * Inserts empty rows or columns at `start`, moving those from there on down or right; they take
 * the format of the row or column before them, or after them at the top or the left edge.
 */
export async function insertDimension(accessToken: string, spreadsheetId: string, dimension: Dimension): Promise<Result<void, ApiError>> {
	const answer = await updateSpreadsheet(accessToken, spreadsheetId, {insertDimension: {range: dimensionRange(dimension), inheritFromBefore: dimension.start > 0}}, z.object({}));
	return answer.map(() => undefined);
}

/** Adds empty rows or columns after a tab's last, `count` of them; `start` is left out, as they go at the end. */
export async function appendDimension(accessToken: string, spreadsheetId: string, {sheetId, dimension, count}: Omit<Dimension, 'start'>): Promise<Result<void, ApiError>> {
	const answer = await updateSpreadsheet(accessToken, spreadsheetId, {appendDimension: {sheetId, dimension, length: count}}, z.object({}));
	return answer.map(() => undefined);
}

/** Deletes rows or columns, with what they hold, moving those after them up or left. */
export async function deleteDimension(accessToken: string, spreadsheetId: string, dimension: Dimension): Promise<Result<void, ApiError>> {
	const answer = await updateSpreadsheet(accessToken, spreadsheetId, {deleteDimension: {range: dimensionRange(dimension)}}, z.object({}));
	return answer.map(() => undefined);
}

const addSheetSchema = z.object({replies: z.tuple([z.object({addSheet: sheetSchema})])});

/** Adds an empty tab after the others, and answers it. */
export async function addSheet(accessToken: string, spreadsheetId: string, title: string): Promise<Result<Sheet, ApiError>> {
	const answer = await updateSpreadsheet(accessToken, spreadsheetId, {addSheet: {properties: {title}}}, addSheetSchema);
	return answer.map(({replies: [{addSheet}]}) => sheetOf(addSheet));
}

/** Deletes a tab, with everything on it. */
export async function deleteSheet(accessToken: string, spreadsheetId: string, sheetId: number): Promise<Result<void, ApiError>> {
	const answer = await updateSpreadsheet(accessToken, spreadsheetId, {deleteSheet: {sheetId}}, z.object({}));
	return answer.map(() => undefined);
}

/** The values in each range, in the order asked, one list of cells a row. */
export async function getRanges(accessToken: string, spreadsheetId: string, ranges: string[]): Promise<Result<string[][][], ApiError>> {
	const url = new URL(`${SHEETS}/${spreadsheetId}/values:batchGet`);
	for (const range of ranges) {
		url.searchParams.append('ranges', range);
	}
	const batch = await googleRequest(accessToken, url, batchSchema);
	return batch.map(({valueRanges}) => valueRanges.map((range) => range.values ?? []));
}

/** A column's position counting from 0, from its letters: 0 for A, 26 for AA. */
export function columnIndex(letters: string): number {
	return [...letters].reduce((index, letter) => index * 26 + (letter.charCodeAt(0) - 64), 0) - 1;
}

/** A column's letters, from its position counting from 0: A, Z, AA. */
export function columnLetters(index: number): string {
	const letter = String.fromCharCode(65 + (index % 26));
	return index < 26 ? letter : `${columnLetters(Math.floor(index / 26) - 1)}${letter}`;
}

// ---- Cells as they were entered, for an exact undo ---------------------------------------------

/** A rectangle of a tab's cells, by the tab's id and the first row's and column's positions counting from 0. */
export type CellArea = {sheetId: number; row: number; column: number; rows: number; columns: number};

/** An area in A1 notation inside its tab, without the tab: `B2:D4`. */
export function areaRange(area: Pick<CellArea, 'row' | 'column' | 'rows' | 'columns'>): string {
	return `${columnLetters(area.column)}${area.row + 1}:${columnLetters(area.column + area.columns - 1)}${area.row + area.rows}`;
}

/** An area in A1 notation with its tab: `'Q1 Sales'!B2:D4`. */
function tabRange(title: string, area: Pick<CellArea, 'row' | 'column' | 'rows' | 'columns'>): string {
	return `${quotedTitle(title)}!${areaRange(area)}`;
}

const AREA = /^\$?([A-Z]{1,3})\$?(\d{1,7}):\$?([A-Z]{1,3})\$?(\d{1,7})$/;

/** The area `B2:D4` names inside a tab; null for anything else. */
export function parseArea(range: string): Pick<CellArea, 'row' | 'column' | 'rows' | 'columns'> | null {
	const [, first, top, last, bottom] = AREA.exec(range) ?? [];
	if (!first || !top || !last || !bottom) {
		return null;
	}
	const area = {row: Number(top) - 1, column: columnIndex(first), rows: Number(bottom) - Number(top) + 1, columns: columnIndex(last) - columnIndex(first) + 1};
	return area.row >= 0 && area.rows > 0 && area.columns > 0 ? area : null;
}

// What a cell holds as it was entered: a formula, text, a number or a yes or no; an error typed in
// is the one kind with no value to put back.
const enteredSchema = z.object({
	formulaValue: z.string().optional(),
	stringValue: z.string().optional(),
	numberValue: z.number().optional(),
	boolValue: z.boolean().optional(),
	errorValue: z.object({}).loose().optional(),
});

const gridSchema = z.object({
	sheets: z
		.array(
			z.object({
				data: z
					.array(
						z.object({
							startRow: z.number().optional(),
							startColumn: z.number().optional(),
							rowData: z.array(z.object({values: z.array(z.object({userEnteredValue: enteredSchema.optional()})).optional()})).optional(),
						}),
					)
					.optional(),
			}),
		)
		.optional(),
});

type Entered = z.infer<typeof enteredSchema>;

// A cell as it was entered, or undefined for one that can't be put back as it was.
function cellOf(entered: Entered | undefined): SheetCell | undefined {
	if (entered === undefined) {
		return null;
	}
	if (entered.formulaValue !== undefined) {
		return {formula: entered.formulaValue};
	}
	if (entered.stringValue !== undefined) {
		return {value: entered.stringValue};
	}
	if (entered.numberValue !== undefined) {
		return {value: entered.numberValue};
	}
	if (entered.boolValue !== undefined) {
		return {value: entered.boolValue};
	}
	return entered.errorValue === undefined ? null : undefined;
}

/**
 * The cells of `area` of the tab called `title` as they were entered, row by row, every row as wide
 * as the area: a formula told apart from text that merely starts with `=`, so that writing them
 * back gives them exactly as they were. Null where one of them can't be: an error typed in.
 */
export function getEnteredCells(accessToken: string, spreadsheetId: string, title: string, area: CellArea): Promise<Result<SheetCell[][] | null, ApiError>> {
	return Do(async ($) => {
		const url = new URL(`${SHEETS}/${spreadsheetId}`);
		url.searchParams.set('ranges', tabRange(title, area));
		url.searchParams.set('fields', 'sheets(data(startRow,startColumn,rowData(values(userEnteredValue))))');
		const {sheets = []} = $(await googleRequest(accessToken, url, gridSchema));
		const grid = sheets.flatMap((sheet) => sheet.data ?? [])[0];
		// Sheets leaves out the empty rows and cells at the end of what it answers.
		const rows = grid?.rowData ?? [];
		const cells: SheetCell[][] = [];
		for (let row = 0; row < area.rows; row += 1) {
			const values = rows[row]?.values ?? [];
			const line: SheetCell[] = [];
			for (let column = 0; column < area.columns; column += 1) {
				const cell = cellOf(values[column]?.userEnteredValue);
				if (cell === undefined) {
					return null;
				}
				line.push(cell);
			}
			cells.push(line);
		}
		return cells;
	});
}

// A cell as Sheets takes it to be entered: the formula, or the value of its kind; none empties it.
function enteredOf(cell: SheetCell): {userEnteredValue?: Record<string, string | number | boolean>} {
	if (cell === null) {
		return {};
	}
	if ('formula' in cell) {
		return {userEnteredValue: {formulaValue: cell.formula}};
	}
	if (typeof cell.value === 'string') {
		return {userEnteredValue: {stringValue: cell.value}};
	}
	if (typeof cell.value === 'number') {
		return {userEnteredValue: {numberValue: cell.value}};
	}
	return {userEnteredValue: {boolValue: cell.value}};
}

/** Puts cells back into `area` exactly as they were entered, each a formula or a value of its own kind, an empty one cleared; their formats stay. */
export async function putEnteredCells(accessToken: string, spreadsheetId: string, area: CellArea, cells: SheetCell[][]): Promise<Result<void, ApiError>> {
	const request = {
		updateCells: {
			range: {sheetId: area.sheetId, startRowIndex: area.row, endRowIndex: area.row + area.rows, startColumnIndex: area.column, endColumnIndex: area.column + area.columns},
			rows: cells.map((row) => ({values: row.map(enteredOf)})),
			fields: 'userEnteredValue',
		},
	};
	const answer = await googleWrite(accessToken, 'POST', new URL(`${SHEETS}/${spreadsheetId}:batchUpdate`), {requests: [request]}, z.object({}));
	return answer.map(() => undefined);
}
