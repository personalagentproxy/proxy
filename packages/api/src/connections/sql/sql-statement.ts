import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

/**
 * What an agent's query may be: one statement that only reads. A read-only transaction stops
 * writes once it runs, but not everything: MySQL lets a DDL statement commit it and go ahead, and
 * a second statement after a semicolon would run too, a COMMIT first ending the transaction. So
 * the statement is checked first: one alone, with no semicolon but at its end, starting with a
 * word that only reads. A semicolon in a string or a comment is refused too: telling one apart
 * means reading quotes and comments as each database does (Postgres's `$tag$` strings and its
 * backslashes, which escape nothing; MySQL's `#` comments), and getting that wrong runs a write.
 */

const READS = ['select', 'with', 'show', 'explain', 'describe', 'desc', 'table', 'values'];

export type Statement = {sql: string; keyword: string};

/** The statement a query runs, when it is one statement that reads; the agent is told what it may be otherwise. */
export function checkStatement(text: string): Result<Statement, ApiError> {
	// A trailing semicolon ends the statement rather than starting another.
	const sql = text.trim().replace(/[\s;]+$/, '');
	if (sql === '') {
		return Err(ApiErr.validationError('Write the SQL to run'));
	}
	if (sql.includes(';')) {
		return Err(ApiErr.validationError('One statement at a time, with no semicolon inside it'));
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
