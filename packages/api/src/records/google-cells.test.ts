import {describe, expect, test} from 'bun:test';

import {areaRange, parseArea, type Sheet} from '../connections/google/sheets-api';
import {cellsOfRange, cellsOfRow, emptyCells, MAX_UNDO_CELLS} from './google-cells';

const SHEETS: Sheet[] = [
	{sheetId: 0, title: 'Summary', rowCount: 1000, columnCount: 26},
	{sheetId: 7, title: "Dana's Q1!", rowCount: 50, columnCount: 5},
];

// Where a write of `rows` by `columns` cells at `range` lands, as A1 notation inside its tab.
function landsAt(range: string, rows = 2, columns = 3): [number, string] | null {
	const written = cellsOfRange('1Budget', SHEETS, range, {rows, columns});
	return written ? [written.tab.sheetId, areaRange(written.area)] : null;
}

describe('where a write lands', () => {
	test('from the range’s first cell, in the tab named, quoted or not, or the first', () => {
		expect(landsAt('B2')).toEqual([0, 'B2:D3']);
		expect(landsAt('$b$2:$z$90')).toEqual([0, 'B2:D3']);
		expect(landsAt("'Dana''s Q1!'!C4")).toEqual([7, 'C4:E5']);
		expect(landsAt('Summary!AA1', 1, 1)).toBeNull();
		expect(landsAt('Summary!Z1', 1, 1)).toEqual([0, 'Z1:Z1']);
	});

	test('a whole column from its top, a whole row from column A, a tab alone from its first cell', () => {
		expect(landsAt('C:C')).toEqual([0, 'C1:E2']);
		expect(landsAt('Summary!4:9')).toEqual([0, 'A4:C5']);
		expect(landsAt('Summary')).toEqual([0, 'A1:C2']);
		expect(landsAt("'Dana''s Q1!'")).toEqual([7, 'A1:C2']);
	});

	test('nowhere it can tell, as a named range or a tab that isn’t there, past the grid, or more cells than an undo keeps', () => {
		expect(landsAt('Totals')).toBeNull();
		expect(landsAt('Nowhere!A1')).toBeNull();
		expect(landsAt("'Dana''s Q1!'!A50")).toBeNull();
		expect(landsAt('A1', 101, 100)).toBeNull();
		expect(landsAt('A1', MAX_UNDO_CELLS / 10, 10)).toEqual([0, 'A1:J1000']);
	});

	test('a row’s cells from the first written to the last, empty before it was added', () => {
		const row = cellsOfRow('1Budget', {sheetId: 0, title: 'Summary', rowCount: 1000, columnCount: 26}, 4, 1, 3);
		expect(row && areaRange(row.area)).toBe('B4:D4');
		expect(row && emptyCells(row)).toEqual([[null, null, null]]);
	});
});

describe('A1 areas', () => {
	test('are read back as written, and nothing else is one', () => {
		expect(parseArea('B2:D4')).toEqual({row: 1, column: 1, rows: 3, columns: 3});
		expect(parseArea('AA10:AB10')).toEqual({row: 9, column: 26, rows: 1, columns: 2});
		expect(areaRange({row: 9, column: 26, rows: 1, columns: 2})).toBe('AA10:AB10');
		expect([parseArea('B2'), parseArea('D4:B2'), parseArea('A0:B1'), parseArea("'Q1'!A1:B2")]).toEqual([null, null, null, null]);
	});
});
