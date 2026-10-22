import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';

import {sqlCredentialSchema, type SqlCredential, type SqlDialect} from '../connections/sql/credential';
import {withSql, type SqlRun} from '../connections/sql/sql-client';
import {checkStatement} from '../connections/sql/sql-statement';
import {decryptSecret} from '../utils/secret-crypto';
import {requireFirstPage, type Connector, type DataRecord, type ListQuery, type RecordPage, type RecordTarget, type RecordValues} from './connector';
import {dialectOf, type Column, type Dialect, type TableInfo, type TableRef} from './sql-dialect';
import {readValueLines, valueLines} from './value-lines';

/**
 * A database, read and written live, as the user the connection signs in as. Its tables are a
 * tree: the top lists them, and inside a table are its rows, a page at a time, newest first by
 * their primary key. A row reads as "column: value" lines and is found again by its key, so only
 * a table with a primary key is written to; one without is read and nothing more. A query is one
 * statement that reads, run in a read-only transaction and answered a page of rows at a time.
 */

const PAGE_SIZE = 50;
const QUERY_LIMIT = 200;
const SUMMARY_LENGTH = 80;

// A table with its columns, those in the primary key in the key's order.
type Table = TableRef & {columns: Column[]; keys: Column[]};

// A record id: a table's, or a row's, by its key or, in a table without one, by where it is.
type RecordRef = {table: TableRef; row: {key: string[]} | {offset: number} | null};

function credentialOf(target: RecordTarget): Result<SqlCredential, ApiError> {
	return Do<SqlCredential, ApiError>(($) => {
		const stored = $(requirePresent(target.connection.credential, ApiErr.internalError(new Error('The connection has no credential'))));
		const json = $(decryptSecret(stored));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		return $(parseSchema(sqlCredentialSchema, parsed));
	});
}

function connect<T>(dialect: Dialect, target: RecordTarget, fn: (run: SqlRun) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const credential = $(credentialOf(target));
		return $(await withSql(dialect.id, credential, fn));
	});
}

function encodePart(part: string): string {
	return encodeURIComponent(part);
}

function tableTitle(table: TableRef): string {
	return table.schema === null ? table.name : `${table.schema}.${table.name}`;
}

function parseRecordId(dialect: Dialect, id: string): RecordRef | null {
	const colon = id.indexOf(':');
	const table = dialect.parseTableId(colon === -1 ? id : id.slice(0, colon));
	if (!table) {
		return null;
	}
	if (colon === -1) {
		return {table, row: null};
	}
	const rest = id.slice(colon + 1);
	if (rest.startsWith('@')) {
		const offset = Number(rest.slice(1));
		return Number.isInteger(offset) && offset >= 0 ? {table, row: {offset}} : null;
	}
	const key = rest.split(',').map((part) => {
		try {
			return decodeURIComponent(part);
		} catch {
			return null;
		}
	});
	return key.every((part): part is string => part !== null) ? {table, row: {key}} : null;
}

function rowId(dialect: Dialect, table: TableRef, row: {key: string[]} | {offset: number}): string {
	const where = 'key' in row ? row.key.map(encodePart).join(',') : `@${row.offset}`;
	return `${dialect.tableId(table)}:${where}`;
}

// A value as the agent reads it, and writes it back: nothing for NULL, a date as the dialect takes
// it, bytes in hex, and JSON for what the database answered as JSON.
function textOf(dialect: Dialect, value: unknown, column: Column | null): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (value instanceof Date) {
		return dialect.formatDate(value, column?.type ?? null);
	}
	if (value instanceof Uint8Array) {
		return `\\x${Buffer.from(value).toString('hex')}`;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

// A query's value as JSON: as the database answered it, dates and bytes written out.
function jsonOf(dialect: Dialect, value: unknown): unknown {
	if (value instanceof Date || value instanceof Uint8Array || typeof value === 'bigint') {
		return textOf(dialect, value, null);
	}
	return value;
}

function columnLine(column: Column): string {
	const notes = [column.notNull ? 'not null' : '', column.keyPosition !== null ? 'primary key' : '', column.default !== null ? `default ${column.default}` : ''].filter((note) => note !== '');
	return [column.name, column.type, ...notes].join(' ');
}

function tableSummary(info: Pick<TableInfo, 'estimate' | 'columns'>): string {
	const columns = `${info.columns} ${info.columns === 1 ? 'column' : 'columns'}`;
	if (info.estimate === null) {
		return columns;
	}
	return `about ${info.estimate.toLocaleString('en-US')} ${info.estimate === 1 ? 'row' : 'rows'}, ${columns}`;
}

function tableRecord(dialect: Dialect, info: TableInfo, columns: Column[] | null): DataRecord {
	return {
		id: dialect.tableId(info),
		values: {name: tableTitle(info), kind: info.kind, summary: tableSummary(info), columns: columns ? columns.map(columnLine).join('\n') : ''},
		updatedAt: '',
		hasChildren: true,
	};
}

function keyOf(dialect: Dialect, table: Table, row: Record<string, unknown>): string[] {
	return table.keys.map((column) => textOf(dialect, row[column.name], column));
}

function rowRecord(dialect: Dialect, table: Table, row: Record<string, unknown>, offset: number): DataRecord {
	const where: {key: string[]} | {offset: number} = table.keys.length > 0 ? {key: keyOf(dialect, table, row)} : {offset};
	const name = 'key' in where ? `${table.name} ${where.key.join(', ')}` : `${table.name} row ${offset + 1}`;
	const summary = table.columns
		.filter((column) => column.keyPosition === null)
		.map((column) => textOf(dialect, row[column.name], column))
		.filter((value) => value !== '')
		.slice(0, 3)
		.join(', ');
	return {
		id: rowId(dialect, table, where),
		values: {
			name,
			kind: 'Row',
			summary: summary.length > SUMMARY_LENGTH ? `${summary.slice(0, SUMMARY_LENGTH - 1)}…` : summary,
			values: valueLines(table.columns.map((column) => [column.name, textOf(dialect, row[column.name], column)])),
		},
		updatedAt: '',
	};
}

function notFound(id: string): ApiError {
	return ApiErr.notFound('record', id);
}

// A table's columns, or not found; the keys in their order.
function tableOf(dialect: Dialect, run: SqlRun, ref: TableRef): Promise<Result<Table, ApiError>> {
	return Do(async ($) => {
		const columns = $(await dialect.listColumns(run, ref));
		if (columns.length === 0) {
			return $(Err(notFound(dialect.tableId(ref))));
		}
		const keys = columns.filter((column) => column.keyPosition !== null).sort((a, b) => (a.keyPosition ?? 0) - (b.keyPosition ?? 0));
		return {...ref, columns, keys};
	});
}

function from(dialect: Dialect, table: TableRef): string {
	return table.schema === null ? dialect.quote(table.name) : `${dialect.quote(table.schema)}.${dialect.quote(table.name)}`;
}

// WHERE the key's columns are the key, the params after those already numbered.
function whereKey(dialect: Dialect, table: Table, from: number): string {
	return table.keys.map((column, index) => `${dialect.quote(column.name)} = ${dialect.param(from + index + 1)}`).join(' AND ');
}

function selectByKey(dialect: Dialect, run: SqlRun, table: Table, key: string[]): Promise<Result<Record<string, unknown> | null, ApiError>> {
	return Do(async ($) => {
		if (key.length !== table.keys.length) {
			return null;
		}
		const {rows} = $(await run(`SELECT * FROM ${from(dialect, table)} WHERE ${whereKey(dialect, table, 0)}`, key));
		return rows[0] ?? null;
	});
}

// Every word somewhere in the row: its columns as text, the pattern's own wildcards escaped. One
// param per placeholder, as MySQL's `?` needs.
function searchClause(dialect: Dialect, table: Table, search: string): {where: string; params: string[]} {
	const words = search.split(/\s+/).filter((word) => word !== '');
	const params: string[] = [];
	const where = words
		.map((word) => {
			const pattern = `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
			const matches = table.columns.map((column) => {
				params.push(pattern);
				return dialect.textMatch(dialect.quote(column.name), dialect.param(params.length));
			});
			return `(${matches.join(' OR ')})`;
		})
		.join(' AND ');
	return {where, params};
}

// A page of a table's rows, the newest first where there is a key to go by.
function listRows(dialect: Dialect, run: SqlRun, table: Table, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const offset = Number(query.page ?? 0);
		if (!Number.isInteger(offset) || offset < 0) {
			return $(Err(ApiErr.validationError('Not a page')));
		}
		const search = query.search === null ? {where: '', params: []} : searchClause(dialect, table, query.search);
		const where = search.where === '' ? '' : ` WHERE ${search.where}`;
		const order = table.keys.length === 0 ? '' : ` ORDER BY ${table.keys.map((column) => `${dialect.quote(column.name)} DESC`).join(', ')}`;
		const {rows} = $(await run(`SELECT * FROM ${from(dialect, table)}${where}${order} LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`, search.params));
		return {
			records: rows.slice(0, PAGE_SIZE).map((row, index) => rowRecord(dialect, table, row, offset + index)),
			nextPage: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
			trail: [{id: dialect.tableId(table), title: tableTitle(table)}],
		};
	});
}

// The row a record id names, or not found.
function rowOf(dialect: Dialect, run: SqlRun, table: Table, ref: RecordRef, recordId: string): Promise<Result<Record<string, unknown>, ApiError>> {
	return Do(async ($) => {
		if (ref.row === null) {
			return $(Err(notFound(recordId)));
		}
		if ('key' in ref.row) {
			return $(requirePresent($(await selectByKey(dialect, run, table, ref.row.key)), notFound(recordId)));
		}
		if (table.keys.length > 0) {
			return $(Err(notFound(recordId)));
		}
		const {rows} = $(await run(`SELECT * FROM ${from(dialect, table)} LIMIT 1 OFFSET ${ref.row.offset}`));
		return $(requirePresent(rows[0], notFound(recordId)));
	});
}

// What the agent wrote, by column, only the columns it named; one it doesn't have is turned down.
function writtenValues(table: Table, values: RecordValues): Result<[Column, string][], ApiError> {
	return readValueLines(
		values.values ?? '',
		table.columns.map((column) => column.name),
	).map((written) => table.columns.flatMap((column): [Column, string][] => (column.name in written ? [[column, written[column.name] ?? '']] : [])));
}

function requireKeyed(table: Table, what: string): Result<void, ApiError> {
	if (table.keys.length === 0) {
		return Err(ApiErr.validationError(`${tableTitle(table)} has no primary key, so its rows can't be ${what} here`));
	}
	return Ok(undefined);
}

// A record id that names a row with a key, in a table with one.
function keyedRow(dialect: Dialect, run: SqlRun, recordId: string, what: string): Promise<Result<{table: Table; key: string[]}, ApiError>> {
	return Do(async ($) => {
		const ref = $(requirePresent(parseRecordId(dialect, recordId), notFound(recordId)));
		if (ref.row === null) {
			return $(Err(notFound(recordId)));
		}
		const table = $(await tableOf(dialect, run, ref.table));
		$(requireKeyed(table, what));
		if (!('key' in ref.row)) {
			return $(Err(notFound(recordId)));
		}
		return {table, key: ref.row.key};
	});
}

// The row after a write: what the write answered, or the row read again by its key.
function written(dialect: Dialect, run: SqlRun, table: Table, answered: Record<string, unknown> | undefined, key: string[]): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const row = answered ?? $(await selectByKey(dialect, run, table, key));
		return rowRecord(dialect, table, $(requirePresent(row, notFound(rowId(dialect, table, {key})))), 0);
	});
}

function queryRowsText(count: number, more: boolean): string {
	if (count === 0) {
		return 'No rows';
	}
	const rows = `${count} ${count === 1 ? 'row' : 'rows'}`;
	return more ? `${rows}, more left out` : rows;
}

/** The connector for one dialect: its tables as a tree of rows, and its queries. */
export function sqlConnector(id: SqlDialect): Connector {
	const dialect = dialectOf(id);
	return {
		list: (target, query) =>
			connect(dialect, target, (run) =>
				Do(async ($) => {
					if (query.parent === null) {
						$(requireFirstPage(query));
						const tables = $(await dialect.listTables(run));
						const words = (query.search ?? '')
							.toLowerCase()
							.split(/\s+/)
							.filter((word) => word !== '');
						const matching = tables.filter((table) => words.every((word) => tableTitle(table).toLowerCase().includes(word)));
						return {records: matching.map((table) => tableRecord(dialect, table, null)), nextPage: null};
					}
					const ref = parseRecordId(dialect, query.parent);
					if (!ref || ref.row !== null) {
						return $(Err(notFound(query.parent)));
					}
					const table = $(await tableOf(dialect, run, ref.table));
					return $(await listRows(dialect, run, table, query));
				}),
			),
		get: (target, recordId) =>
			connect(dialect, target, (run) =>
				Do(async ($) => {
					const ref = $(requirePresent(parseRecordId(dialect, recordId), notFound(recordId)));
					const table = $(await tableOf(dialect, run, ref.table));
					if (ref.row === null) {
						const info = $(await dialect.listTables(run)).find((candidate) => candidate.schema === table.schema && candidate.name === table.name);
						return tableRecord(dialect, info ?? {...table, kind: 'Table', estimate: null, columns: table.columns.length}, table.columns);
					}
					const row = $(await rowOf(dialect, run, table, ref, recordId));
					return rowRecord(dialect, table, row, 'offset' in ref.row ? ref.row.offset : 0);
				}),
			),
		// A new row goes in the table given as parent, with the values written and the table's
		// defaults for the rest.
		create: (target, values, parent) =>
			connect(dialect, target, (run) =>
				Do(async ($) => {
					if (parent === null) {
						return $(Err(ApiErr.validationError('Say which table the row goes in, as parent')));
					}
					const ref = parseRecordId(dialect, parent);
					if (!ref || ref.row !== null) {
						return $(Err(notFound(parent)));
					}
					const table = $(await tableOf(dialect, run, ref.table));
					$(requireKeyed(table, 'added'));
					const entries = $(writtenValues(table, values)).filter(([, value]) => value !== '');
					if (entries.length === 0) {
						return $(Err(ApiErr.validationError('Write the row’s values, one "column: value" a line')));
					}
					const columns = entries.map(([column]) => dialect.quote(column.name)).join(', ');
					const placeholders = entries.map((_, index) => dialect.param(index + 1)).join(', ');
					const answer = $(
						await run(
							`INSERT INTO ${from(dialect, table)} (${columns}) VALUES (${placeholders})${dialect.returning ? ' RETURNING *' : ''}`,
							entries.map(([, value]) => value),
						),
					);
					// Without RETURNING, the row is read again by its key: the one the database numbered,
					// else the key as written.
					const [only] = table.keys;
					const numbered = only && table.keys.length === 1 && only.autoIncrement ? answer.lastInsertId : null;
					const key = numbered !== null ? [numbered] : table.keys.map((column) => entries.find(([candidate]) => candidate === column)?.[1] ?? '');
					return $(await written(dialect, run, table, answer.rows[0], key));
				}),
			),
		// Only the columns written differently from how they read change; one written empty is set
		// to NULL, and one left out stays as it is.
		update: (target, recordId, values) =>
			connect(dialect, target, (run) =>
				Do(async ($) => {
					const {table, key} = $(await keyedRow(dialect, run, recordId, 'edited'));
					const current = $(requirePresent($(await selectByKey(dialect, run, table, key)), notFound(recordId)));
					const changed = $(writtenValues(table, values)).filter(([column, value]) => value !== textOf(dialect, current[column.name], column));
					if (changed.length === 0) {
						return rowRecord(dialect, table, current, 0);
					}
					const sets = changed.map(([column], index) => `${dialect.quote(column.name)} = ${dialect.param(index + 1)}`).join(', ');
					const params = [...changed.map(([, value]) => (value === '' ? null : value)), ...key];
					const answer = $(await run(`UPDATE ${from(dialect, table)} SET ${sets} WHERE ${whereKey(dialect, table, changed.length)}${dialect.returning ? ' RETURNING *' : ''}`, params));
					if (answer.affected === 0 && answer.rows.length === 0) {
						return $(Err(notFound(recordId)));
					}
					const after = table.keys.map((column) => changed.find(([candidate]) => candidate === column)?.[1] ?? key[table.keys.indexOf(column)] ?? '');
					return $(await written(dialect, run, table, answer.rows[0], after));
				}),
			),
		remove: (target, recordId) =>
			connect(dialect, target, (run) =>
				Do(async ($) => {
					const {table, key} = $(await keyedRow(dialect, run, recordId, 'deleted'));
					const answer = $(await run(`DELETE FROM ${from(dialect, table)} WHERE ${whereKey(dialect, table, 0)}`, key));
					if (answer.affected === 0) {
						return $(Err(notFound(recordId)));
					}
				}),
			),
		newCommands: {
			// One statement that reads, checked before any connection is made, answered as one JSON
			// object a line, QUERY_LIMIT rows at most.
			run: (target, values) =>
				Do(async ($) => {
					const statement = $(checkStatement(values.sql ?? ''));
					return $(
						await connect(dialect, target, (run) =>
							Do(async ($) => {
								const {rows, more} = $(await dialect.query(run, statement, QUERY_LIMIT));
								const result = rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).map(([column, value]) => [column, jsonOf(dialect, value)])))).join('\n');
								return {id: 'query', values: {sql: statement.sql, rows: queryRowsText(rows.length, more), result}, updatedAt: new Date().toISOString()};
							}),
						),
					);
				}),
		},
	};
}
