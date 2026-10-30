import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {DRIVE_ID} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {getValues, putValues} from '../connections/google/sheets-api';
import type {DataRecord, NewCommandRunner, RecordValues, RunOnly} from './connector';
import {csvOf, parseCsv} from './csv';

/**
 * A spreadsheet's ranges as the `ranges` collection: never listed or opened, only read or written,
 * a range at a time, in A1 notation with the tab, `'Q1 Sales'!A1:F20`. Values go in and come out
 * as CSV, one row a line; they are read as Sheets shows them and written as if typed in.
 */

// The spreadsheet in a link to it, `…/spreadsheets/d/<id>/edit`, or in Drive's `?id=` links.
function spreadsheetIdOf(text: string): string | null {
	const trimmed = text.trim();
	if (DRIVE_ID.test(trimmed)) {
		return trimmed;
	}
	const url = URL.parse(trimmed);
	if (!url || url.protocol !== 'https:' || !/(^|\.)google\.com$/.test(url.hostname)) {
		return null;
	}
	const id = /\/d\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
	return id && DRIVE_ID.test(id) ? id : null;
}

function requireSpreadsheet(values: RecordValues): Result<string, ApiError> {
	const id = spreadsheetIdOf(values.spreadsheet ?? '');
	if (id === null) {
		return Err(ApiErr.validationError('Say which spreadsheet as spreadsheet: its id, or its link'));
	}
	return Ok(id);
}

// A tab's title, quoted as A1 notation quotes it, a quote in it doubled, or one of letters, digits
// and underscores alone as it is.
const TAB = String.raw`(?:'(?:[^'\x00-\x1f]|''){1,100}'|[\p{L}\p{N}_]{1,100})`;
// A cell (B2, or $B$2 as a formula fixes it), a whole column (B) or a whole row (2).
const CELL = String.raw`(?:\$?[A-Za-z]{1,3}(?:\$?\d{1,7})?|\$?\d{1,7})`;
const A1 = new RegExp(String.raw`^(?:${TAB}!)?${CELL}(?::${CELL})?$|^${TAB}$`, 'u');

function requireRange(values: RecordValues): Result<string, ApiError> {
	const range = (values.range ?? '').trim();
	if (!A1.test(range)) {
		return Err(ApiErr.validationError(`Write the range in A1 notation, such as 'Sheet1'!A1:F20, or A1:F20 in the first tab, not “${range}”`));
	}
	return Ok(range);
}

// The rows a range answers at most, as a database's query answers 200: a whole tab can be far more
// than an agent can take in at once.
const MAX_ROWS = 1000;

function rowsText(count: number): string {
	if (count === 0) {
		return 'No rows';
	}
	if (count > MAX_ROWS) {
		return `The first ${MAX_ROWS} of ${count} rows: read the rest as a range starting below them`;
	}
	return `${count} ${count === 1 ? 'row' : 'rows'}`;
}

function rangeRecord(spreadsheet: string, range: string, values: string[][]): DataRecord {
	return {id: 'range', values: {spreadsheet, range, rows: rowsText(values.length), result: csvOf(values.slice(0, MAX_ROWS))}, updatedAt: new Date().toISOString()};
}

/** A range's values, as CSV in `result`. */
const read: NewCommandRunner = (target, values) =>
	Do(async ($) => {
		const spreadsheet = $(requireSpreadsheet(values));
		const range = $(requireRange(values));
		const answer = $(await callGoogle(target.connection, (token) => getValues(token, spreadsheet, range)));
		return rangeRecord(spreadsheet, answer.range, answer.values);
	});

/** Writes `values` into a range and answers what it holds now, formulas worked out. */
const write: NewCommandRunner = (target, values) =>
	Do(async ($) => {
		const spreadsheet = $(requireSpreadsheet(values));
		const range = $(requireRange(values));
		const rows = $(parseCsv(values.values ?? ''));
		if (rows.length === 0) {
			return $(Err(ApiErr.validationError('Write the values as CSV, one row a line; "" empties a cell')));
		}
		const answer = $(await callGoogle(target.connection, (token) => putValues(token, spreadsheet, range, rows)));
		return rangeRecord(spreadsheet, answer.range, answer.values);
	});

export const rangesConnector = {newCommands: {read, write}} satisfies RunOnly;
