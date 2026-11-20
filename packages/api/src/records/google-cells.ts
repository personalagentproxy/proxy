import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {FileUndo, SheetCell} from '@proxy/db/file-undo';

import {areaRange, columnIndex, getEnteredCells, getSheets, parseArea, putEnteredCells, type CellArea, type Sheet} from '../connections/google/sheets-api';
import {log} from '../observability/log';

/**
 * The exact undo of a write to a Sheet's cells (db/file-undo.ts `sheets_cells`): the cells it is
 * about to change are read as they were entered before it, formulas as formulas, and again after
 * it, so that undoing it puts the first back, but only where the cells still hold what it left.
 * A write of more than `MAX_UNDO_CELLS` cells, or of cells that can't be put back as they were, as
 * an error typed in, keeps none: the task's copy of the file gives them back instead.
 */

/** The most cells a write keeps an exact undo of. */
export const MAX_UNDO_CELLS = 10_000;

/** The cells a write changes: in which spreadsheet, in which tab, by its id and its title now, and where. */
export type CellsWritten = {spreadsheetId: string; tab: Sheet; area: CellArea};

/**
 * Where a write of `rows` cells at the range given, in A1 notation, lands, as Sheets writes them
 * from the range's first cell: none where that can't be told, as for a named range, or where it
 * goes past the tab's grid or is more cells than an undo is kept of.
 */
export function cellsOfRange(spreadsheetId: string, sheets: Sheet[], range: string, size: {rows: number; columns: number}): CellsWritten | null {
	const start = rangeStart(range);
	const tab = start && (start.tab === null ? sheets[0] : sheets.find((sheet) => sheet.title === start.tab));
	if (!start || !tab) {
		return null;
	}
	const area = {sheetId: tab.sheetId, row: start.row, column: start.column, ...size};
	return fits(tab, area) ? {spreadsheetId, tab, area} : null;
}

/** The cells of one row of a tab, from `column` to `last`, counting from 0; none where there are more than an undo is kept of. */
export function cellsOfRow(spreadsheetId: string, tab: Sheet, row: number, column: number, last: number): CellsWritten | null {
	const area = {sheetId: tab.sheetId, row: row - 1, column, rows: 1, columns: last - column + 1};
	return area.columns > 0 && area.columns <= MAX_UNDO_CELLS ? {spreadsheetId, tab, area} : null;
}

function fits(tab: Sheet, area: CellArea): boolean {
	return area.rows * area.columns <= MAX_UNDO_CELLS && area.row + area.rows <= tab.rowCount && area.column + area.columns <= tab.columnCount;
}

// A cell's column letters and row number, either left out for a whole row or column.
const CELL = /^\$?([A-Za-z]{1,3})?\$?(\d{1,7})?$/;

// A range's tab, unquoted, and the cells after it; either none where the range has none.
function splitTab(range: string): {tab: string | null; cells: string | null} {
	const quoted = /^'((?:[^']|'')+)'(?:!(.*))?$/.exec(range);
	if (quoted) {
		return {tab: (quoted[1] ?? '').replace(/''/g, "'"), cells: quoted[2] ?? null};
	}
	const bang = range.lastIndexOf('!');
	if (bang === -1) {
		return {tab: null, cells: range};
	}
	return {tab: range.slice(0, bang), cells: range.slice(bang + 1)};
}

/** The tab a range in A1 notation names, unquoted, null for none, and its first cell's row and column counting from 0. */
function rangeStart(range: string): {tab: string | null; row: number; column: number} | null {
	const {tab, cells} = splitTab(range.trim());
	if (cells === null) {
		return tab === null ? null : {tab, row: 0, column: 0};
	}
	const [, letters, digits] = CELL.exec(cells.split(':')[0] ?? '') ?? [];
	if (letters === undefined && digits === undefined) {
		// A word alone is a tab from its first cell, or a named range, which no tab is called.
		return tab === null ? {tab: cells, row: 0, column: 0} : null;
	}
	return {tab, row: digits === undefined ? 0 : Number(digits) - 1, column: letters === undefined ? 0 : columnIndex(letters.toUpperCase())};
}

/** The cells before a write, as they were entered; null where they can't all be put back. */
export function cellsBefore(token: string, written: CellsWritten): Promise<Result<SheetCell[][] | null, ApiError>> {
	return getEnteredCells(token, written.spreadsheetId, written.tab.title, written.area);
}

/** Cells that were empty before a write, as a row added is. */
export function emptyCells(written: CellsWritten): SheetCell[][] {
	return Array.from({length: written.area.rows}, () => Array.from({length: written.area.columns}, (): SheetCell => null));
}

/**
 * The undo of a write, the cells read again after it; none where there was none before, or the
 * cells it left can't be put back. It never fails: it is read once the write is made, which is no
 * less done for a read that fails, and refusing it would have an agent make it again, a row
 * appended twice. A read that fails keeps no undo, and is logged on the server.
 */
export async function cellsUndo(token: string, written: CellsWritten, before: SheetCell[][] | null): Promise<FileUndo | null> {
	if (before === null) {
		return null;
	}
	const after = await getEnteredCells(token, written.spreadsheetId, written.tab.title, written.area);
	if (after.isErr()) {
		log.error('The cells a Sheet write left could not be read for its undo', {spreadsheetId: written.spreadsheetId, errorKind: after.error.kind});
		return null;
	}
	if (after.value === null) {
		return null;
	}
	return {kind: 'sheets_cells', sheetId: written.tab.sheetId, tab: written.tab.title, range: areaRange(written.area), before, after: after.value};
}

function sameCells(one: SheetCell[][], other: SheetCell[][]): boolean {
	return JSON.stringify(one) === JSON.stringify(other);
}

/**
 * Applies a change's undo to the spreadsheet: puts back the cells as they were before it, where
 * they still hold what it left; answers the inverse, which undoes the undo. Refused where the tab
 * is gone or the cells changed since.
 */
export function applyCellsUndo(token: string, spreadsheetId: string, undo: FileUndo): Promise<Result<FileUndo, ApiError>> {
	return Do(async ($) => {
		const place = parseArea(undo.range);
		if (place === null) {
			return $(
				Err(ApiErr.validationError(`That change’s cells, ${undo.range}, aren’t a range this server reads: read the version from before it with files_version_read and write them back instead`)),
			);
		}
		const tab = $(await getSheets(token, spreadsheetId)).find((sheet) => sheet.sheetId === undo.sheetId);
		if (!tab) {
			return $(Err(ApiErr.conflict(`The tab “${undo.tab}” is no longer in the spreadsheet: read the version from before the change with files_version_read and write what it held back instead`)));
		}
		const area = {sheetId: tab.sheetId, ...place};
		const now = $(await getEnteredCells(token, spreadsheetId, tab.title, area));
		if (now === null || !sameCells(now, undo.after)) {
			return $(
				Err(
					ApiErr.conflict(
						`The cells ${undo.range} of “${tab.title}” changed since that change: read the version from before it with files_version_read and write back what should be there (files_versions lists them)`,
					),
				),
			);
		}
		$(await putEnteredCells(token, spreadsheetId, area, undo.before));
		return {...undo, tab: tab.title, before: undo.after, after: undo.before};
	});
}
