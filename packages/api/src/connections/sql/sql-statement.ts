import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

/**
 * What an agent's query may be: one statement that only reads. A read-only transaction stops
 * writes once it runs, but not everything: MySQL lets a DDL statement commit it and go ahead, and
 * a second statement after a semicolon would run too. So the statement is checked first: one
 * alone, starting with a word that only reads.
 */

const READS = ['select', 'with', 'show', 'explain', 'describe', 'desc', 'table', 'values'];

export type Statement = {sql: string; keyword: string};

// Where the statement ends and another would begin: a semicolon outside quotes and comments.
function hasSecondStatement(sql: string): boolean {
	let i = 0;
	while (i < sql.length) {
		const char = sql[i];
		const next = sql[i + 1];
		if (char === '-' && next === '-') {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? sql.length : end + 1;
			continue;
		}
		if (char === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (char === "'" || char === '"' || char === '`') {
			i = closingQuote(sql, i, char);
			continue;
		}
		if (char === ';') {
			return true;
		}
		i += 1;
	}
	return false;
}

// Past the quote that closes the one at `start`: a doubled quote, or one after a backslash, is
// part of the text.
function closingQuote(sql: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < sql.length) {
		const char = sql[i];
		if (char === '\\') {
			i += 2;
			continue;
		}
		if (char === quote && sql[i + 1] === quote) {
			i += 2;
			continue;
		}
		if (char === quote) {
			return i + 1;
		}
		i += 1;
	}
	return sql.length;
}

/** The statement a query runs, when it is one statement that reads; the agent is told what it may be otherwise. */
export function checkStatement(text: string): Result<Statement, ApiError> {
	// A trailing semicolon ends the statement rather than starting another.
	const sql = text.trim().replace(/[\s;]+$/, '');
	if (sql === '') {
		return Err(ApiErr.validationError('Write the SQL to run'));
	}
	if (hasSecondStatement(sql)) {
		return Err(ApiErr.validationError('One statement at a time'));
	}
	// Past any comments to the first word.
	const keyword = sql
		.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '')
		.match(/^[a-zA-Z]+/)?.[0]
		.toLowerCase();
	if (keyword === undefined || !READS.includes(keyword)) {
		return Err(ApiErr.validationError('Only a statement that reads runs here: SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE or VALUES'));
	}
	return Ok({sql, keyword});
}
