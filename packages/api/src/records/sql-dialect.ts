import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';

import type {SqlDialect} from '../connections/sql/credential';
import type {SqlRun} from '../connections/sql/sql-client';
import type {Statement} from '../connections/sql/sql-statement';

/**
 * Where PostgreSQL and MySQL differ for the connector: how names are quoted, how the tables and
 * their columns are looked up, how a query is kept to reading and to a page of rows, and how
 * dates are written so they read back in.
 */

const STATEMENT_TIMEOUT_MS = 30_000;

/** A table by its schema, where the dialect has schemas, and its name. */
export type TableRef = {schema: string | null; name: string};

export type TableInfo = TableRef & {kind: 'Table' | 'View'; estimate: number | null; columns: number};

export type Column = {
	name: string;
	type: string;
	notNull: boolean;
	default: string | null;
	// Its place in the primary key, from 1, or null outside it.
	keyPosition: number | null;
	// The database numbers it itself, as a serial or auto_increment column.
	autoIncrement: boolean;
};

export type QueryRows = {rows: Record<string, unknown>[]; more: boolean};

export type Dialect = {
	id: SqlDialect;
	quote: (identifier: string) => string;
	// The placeholder of the parameter at `index`, from 1.
	param: (index: number) => string;
	// Whether a column, cast to text, contains the pattern a parameter holds, in any case.
	textMatch: (quotedColumn: string, param: string) => string;
	// Whether an insert or update can answer the row it wrote.
	returning: boolean;
	// The tables and views the user can read, with how many rows each has, as far as the server
	// keeps track, and how many columns.
	listTables: (run: SqlRun) => Promise<Result<TableInfo[], ApiError>>;
	// A table's columns in order; none when there is no such table.
	listColumns: (run: SqlRun, table: TableRef) => Promise<Result<Column[], ApiError>>;
	// A checked statement's rows, up to `limit`, saying whether there were more, run in a read-only
	// transaction with a time limit.
	query: (run: SqlRun, statement: Statement, limit: number) => Promise<Result<QueryRows, ApiError>>;
	// A date as the dialect takes it back for a column of `type`, or for a query's row without one.
	formatDate: (date: Date, type: string | null) => string;
	tableId: (table: TableRef) => string;
	parseTableId: (id: string) => TableRef | null;
};

function text(value: unknown): string {
	return value === null || value === undefined ? '' : String(value);
}

function number(value: unknown): number | null {
	const parsed = Number(value);
	return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed;
}

function truthy(value: unknown): boolean {
	return value === true || value === 1 || value === '1' || value === 't';
}

// Only what the dots and colons of ids can't hold is escaped, so `public.users` reads as it is.
function encodePart(part: string): string {
	return encodeURIComponent(part).replace(/\./g, '%2E');
}

function decodePart(part: string): string | null {
	try {
		return decodeURIComponent(part);
	} catch {
		return null;
	}
}

function toColumn(row: Record<string, unknown>): Column {
	const fallback = text(row.default) || null;
	return {
		name: text(row.name),
		type: text(row.type),
		notNull: truthy(row.not_null),
		default: fallback,
		keyPosition: number(row.key_position),
		autoIncrement: truthy(row.auto_increment) || (fallback?.startsWith('nextval(') ?? false),
	};
}

// After the statement, whatever happened: the connection is closed after the request, but a
// rolled-back transaction leaves the server nothing to clean up.
async function rolledBack<T>(run: SqlRun, inner: Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	const outcome = await inner;
	await run('ROLLBACK');
	return outcome;
}

// Explaining, showing and describing answer little; everything else goes through a cursor in
// Postgres, which only takes what selects.
function answersLittle(statement: Statement): boolean {
	return ['explain', 'show', 'describe', 'desc'].includes(statement.keyword);
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

// "2026-01-02 10:00:00", in UTC, as MySQL reads a datetime back.
function mysqlDateTime(date: Date): string {
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export const postgres: Dialect = {
	id: 'postgres',
	quote: (identifier) => `"${identifier.replace(/"/g, '""')}"`,
	param: (index) => `$${index}`,
	textMatch: (column, param) => `CAST(${column} AS TEXT) ILIKE ${param}`,
	returning: true,
	// Through the system catalogs rather than information_schema, which hides the keys of tables
	// the user doesn't own. Row counts are the planner's estimate, -1 until a table is analyzed.
	listTables: (run) =>
		Do(async ($) => {
			const {rows} = $(
				await run(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples AS estimate,
  (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND has_table_privilege(c.oid, 'SELECT')
ORDER BY n.nspname, c.relname`),
			);
			return rows.map((row): TableInfo => {
				const estimate = number(row.estimate);
				return {
					schema: text(row.schema),
					name: text(row.name),
					kind: row.kind === 'v' || row.kind === 'm' ? 'View' : 'Table',
					estimate: estimate === null || estimate < 0 ? null : Math.round(estimate),
					columns: number(row.columns) ?? 0,
				};
			});
		}),
	listColumns: (run, table) =>
		Do(async ($) => {
			const {rows} = $(
				await run(
					`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS "default",
  (SELECT array_position(i.indkey::int2[], a.attnum) FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS key_position,
  (a.attidentity <> '' OR a.attgenerated <> '') AS auto_increment
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`,
					[table.schema ?? 'public', table.name],
				),
			);
			return rows.map(toColumn);
		}),
	// A cursor fetches a page of rows, however many the statement would answer.
	query: (run, statement, limit) =>
		rolledBack(
			run,
			Do(async ($) => {
				$(await run('START TRANSACTION READ ONLY'));
				$(await run(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
				if (answersLittle(statement)) {
					const {rows} = $(await run(statement.sql));
					return {rows: rows.slice(0, limit), more: rows.length > limit};
				}
				$(await run(`DECLARE agent_query NO SCROLL CURSOR FOR ${statement.sql}`));
				const {rows} = $(await run(`FETCH ${limit + 1} FROM agent_query`));
				return {rows: rows.slice(0, limit), more: rows.length > limit};
			}),
		),
	formatDate: (date, type) => (type === 'date' ? date.toISOString().slice(0, 10) : date.toISOString()),
	tableId: (table) => `${encodePart(table.schema ?? 'public')}.${encodePart(table.name)}`,
	parseTableId: (id) => {
		const [schema, name, ...rest] = id.split('.').map(decodePart);
		if (!schema || !name || rest.length > 0) {
			return null;
		}
		return {schema, name};
	},
};

export const mysql: Dialect = {
	id: 'mysql',
	quote: (identifier) => `\`${identifier.replace(/`/g, '``')}\``,
	param: () => '?',
	textMatch: (column, param) => `CAST(${column} AS CHAR) LIKE ${param}`,
	returning: false,
	// The connection is to one database, whose tables these are.
	listTables: (run) =>
		Do(async ($) => {
			const {rows} = $(
				await run(`SELECT t.table_name AS name, t.table_type AS kind, t.table_rows AS estimate,
  (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS columns
FROM information_schema.tables t WHERE t.table_schema = database() ORDER BY t.table_name`),
			);
			return rows.map((row): TableInfo => ({
				schema: null,
				name: text(row.name),
				kind: text(row.kind).toUpperCase() === 'VIEW' ? 'View' : 'Table',
				estimate: number(row.estimate),
				columns: number(row.columns) ?? 0,
			}));
		}),
	listColumns: (run, table) =>
		Do(async ($) => {
			const {rows} = $(
				await run(
					`SELECT c.column_name AS name, c.column_type AS type, c.is_nullable = 'NO' AS not_null, c.column_default AS \`default\`, c.extra LIKE '%auto_increment%' AS auto_increment,
  (SELECT k.ordinal_position FROM information_schema.key_column_usage k WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name AND k.constraint_name = 'PRIMARY') AS key_position
FROM information_schema.columns c WHERE c.table_schema = database() AND c.table_name = ? ORDER BY c.ordinal_position`,
					[table.name],
				),
			);
			return rows.map(toColumn);
		}),
	// MySQL has no cursor to fetch a page from, but caps what a SELECT answers for the session; the
	// time limit is named differently by MariaDB and MySQL.
	query: (run, statement, limit) =>
		rolledBack(
			run,
			Do(async ($) => {
				const version = text($(await run('SELECT VERSION() AS version')).rows[0]?.version).toLowerCase();
				$(await run(version.includes('mariadb') ? `SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_MS / 1000}` : `SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS}`));
				$(await run(`SET SESSION sql_select_limit = ${limit + 1}`));
				$(await run('START TRANSACTION READ ONLY'));
				const {rows} = $(await run(statement.sql));
				return {rows: rows.slice(0, limit), more: rows.length > limit};
			}),
		),
	formatDate: (date, type) => (type === 'date' ? date.toISOString().slice(0, 10) : mysqlDateTime(date)),
	tableId: (table) => encodePart(table.name),
	parseTableId: (id) => {
		const name = decodePart(id);
		return name ? {schema: null, name} : null;
	},
};

export function dialectOf(id: SqlDialect): Dialect {
	return id === 'mysql' ? mysql : postgres;
}
