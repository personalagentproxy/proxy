import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration} from '@proxy/integrations';

import type {SqlResult, SqlRun} from '../connections/sql/sql-client';
import type {RecordTarget} from './connector';

// The database, as the statements the connector sends and what each answers: an answer is picked
// by a piece of the statement, else the statement answers nothing.
type Answer = {match: string; result: Partial<SqlResult>};

const calls: {statement: string; params: unknown[]}[] = [];
let answers: Answer[] = [];

const run: SqlRun = async (statement, params = []) => {
	calls.push({statement, params});
	const found = answers.find((answer) => statement.includes(answer.match));
	return Ok({rows: [], affected: 0, lastInsertId: null, ...found?.result});
};

const withSql = mock(async (_dialect: string, _credential: unknown, fn: (run: SqlRun) => Promise<Result<unknown, ApiError>>) => fn(run));

mock.module('../connections/sql/sql-client', () => ({withSql}));

const credential = {host: 'db.example.com', port: 5432, database: 'app', username: 'reader', password: 'secret', tls: 'verify'};

mock.module('../utils/secret-crypto', () => ({decryptSecret: () => Ok(JSON.stringify(credential))}));

function target(integrationId: 'postgres' | 'mysql', collectionId: string): RecordTarget {
	const integration = findIntegration(integrationId);
	const collection = integration && findCollection(integration, collectionId);
	if (!collection) {
		throw new Error(`No ${collectionId} in ${integrationId}`);
	}
	return {
		connection: {
			id: 'conn-1',
			integrationId,
			orgId: 'org-1',
			ownerUserId: 'user-1',
			connectedById: 'user-1',
			account: 'reader@db.example.com/app',
			createdAt: new Date(),
			tools: null,
			name: null,
			defaults: [],
			credential: 'stored',
		},
		collection,
	};
}

const userColumns = [
	{name: 'id', type: 'integer', not_null: true, default: "nextval('users_id_seq'::regclass)", key_position: 1, auto_increment: false},
	{name: 'email', type: 'text', not_null: true, default: null, key_position: null, auto_increment: false},
	{name: 'signed_up', type: 'timestamp with time zone', not_null: false, default: 'now()', key_position: null, auto_increment: false},
	{name: 'notes', type: 'jsonb', not_null: false, default: null, key_position: null, auto_increment: false},
];

const noQuery = {search: null, page: null, filter: null, parent: null};

beforeEach(() => {
	calls.length = 0;
	answers = [];
});

describe('tables', () => {
	test('lists the tables as a tree, each with its size, matching the words searched for', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [
			{
				match: 'has_table_privilege',
				result: {
					rows: [
						{schema: 'billing', name: 'invoices', kind: 'r', estimate: 1204, columns: '3'},
						{schema: 'public', name: 'events', kind: 'r', estimate: -1, columns: '2'},
						{schema: 'public', name: 'paid_invoices', kind: 'v', estimate: -1, columns: '3'},
					],
				},
			},
		];
		const page = (await sqlConnectors('postgres').tables.list(target('postgres', 'tables'), noQuery)).unwrap();
		expect(page.records).toEqual([
			{id: 'billing.invoices', values: {name: 'billing.invoices', kind: 'Table', summary: 'about 1,204 rows, 3 columns', columns: ''}, updatedAt: '', hasChildren: true},
			{id: 'public.events', values: {name: 'public.events', kind: 'Table', summary: '2 columns', columns: ''}, updatedAt: '', hasChildren: true},
			{id: 'public.paid_invoices', values: {name: 'public.paid_invoices', kind: 'View', summary: '3 columns', columns: ''}, updatedAt: '', hasChildren: true},
		]);
		expect(page.nextPage).toBeNull();
		expect(withSql).toHaveBeenLastCalledWith('postgres', credential, expect.any(Function));

		const found = (await sqlConnectors('postgres').tables.list(target('postgres', 'tables'), {...noQuery, search: 'invoices paid'})).unwrap();
		expect(found.records.map((record) => record.id)).toEqual(['public.paid_invoices']);

		const paged = await sqlConnectors('postgres').tables.list(target('postgres', 'tables'), {...noQuery, page: '50'});
		expect(paged.isErr() && paged.error.kind).toBe('validation_error');
	});

	test('opens a table with its columns, one a line', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [
			{match: 'format_type(', result: {rows: userColumns}},
			{match: 'has_table_privilege', result: {rows: [{schema: 'public', name: 'users', kind: 'r', estimate: 120, columns: '4'}]}},
		];
		const record = (await sqlConnectors('postgres').tables.get(target('postgres', 'tables'), 'public.users')).unwrap();
		expect(record).toEqual({
			id: 'public.users',
			values: {
				name: 'public.users',
				kind: 'Table',
				summary: 'about 120 rows, 4 columns',
				columns: "id integer not null primary key default nextval('users_id_seq'::regclass)\nemail text not null\nsigned_up timestamp with time zone default now()\nnotes jsonb",
			},
			updatedAt: '',
			hasChildren: true,
		});
		expect(calls[0]?.params).toEqual(['public', 'users']);
	});

	test('a table that is not there, or an id that is none, is not found', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		expect((await sqlConnectors('postgres').tables.get(target('postgres', 'tables'), 'public.nope')).unwrapErr()).toMatchObject({kind: 'not_found'});
		expect((await sqlConnectors('postgres').tables.get(target('postgres', 'tables'), 'nope')).unwrapErr()).toMatchObject({kind: 'not_found'});
		expect((await sqlConnectors('postgres').tables.list(target('postgres', 'tables'), {...noQuery, parent: 'public.users:3'})).unwrapErr()).toMatchObject({kind: 'not_found'});
	});

	test('lists a table’s rows newest first by their key, a page at a time, each as "column: value" lines', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		const rows = Array.from({length: 51}, (_, index) => ({id: 120 - index, email: `user${120 - index}@example.com`, signed_up: new Date('2026-10-13T00:09:04.517Z'), notes: {plan: 'free'}}));
		answers = [
			{match: 'format_type(', result: {rows: userColumns}},
			{match: 'SELECT * FROM "public"."users"', result: {rows}},
		];
		const page = (await sqlConnectors('postgres').tables.list(target('postgres', 'tables'), {...noQuery, parent: 'public.users', search: 'user1 free'})).unwrap();
		expect(page.records).toHaveLength(50);
		expect(page.records[0]).toEqual({
			id: 'public.users:120',
			values: {
				name: 'users 120',
				kind: 'Row',
				summary: 'user120@example.com, 2026-10-13T00:09:04.517Z, {"plan":"free"}',
				values: 'id: 120\nemail: user120@example.com\nsigned_up: 2026-10-13T00:09:04.517Z\nnotes: {"plan":"free"}',
			},
			updatedAt: '',
		});
		expect(page.nextPage).toBe('50');
		expect(page.trail).toEqual([{id: 'public.users', title: 'public.users'}]);
		const select = calls[1];
		expect(select?.statement).toBe(
			'SELECT * FROM "public"."users" WHERE (CAST("id" AS TEXT) ILIKE $1 OR CAST("email" AS TEXT) ILIKE $2 OR CAST("signed_up" AS TEXT) ILIKE $3 OR CAST("notes" AS TEXT) ILIKE $4) AND (CAST("id" AS TEXT) ILIKE $5 OR CAST("email" AS TEXT) ILIKE $6 OR CAST("signed_up" AS TEXT) ILIKE $7 OR CAST("notes" AS TEXT) ILIKE $8) ORDER BY "id" DESC LIMIT 51 OFFSET 0',
		);
		expect(select?.params).toEqual(['%user1%', '%user1%', '%user1%', '%user1%', '%free%', '%free%', '%free%', '%free%']);
	});

	test('opens a row by its key, and a composite key by its parts', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [
			{
				match: 'FROM information_schema.columns c',
				result: {
					rows: [
						{name: 'a', type: 'int(11)', not_null: 1, default: null, key_position: 1, auto_increment: 0},
						{name: 'b', type: 'int(11)', not_null: 1, default: null, key_position: 2, auto_increment: 0},
						{name: 'note', type: 'text', not_null: 0, default: null, key_position: null, auto_increment: 0},
					],
				},
			},
			{match: 'SELECT * FROM `pairs` WHERE `a` = ? AND `b` = ?', result: {rows: [{a: 3, b: 4, note: 'three, four'}]}},
		];
		const record = (await sqlConnectors('mysql').tables.get(target('mysql', 'tables'), 'pairs:3,4')).unwrap();
		expect(record).toEqual({id: 'pairs:3,4', values: {name: 'pairs 3, 4', kind: 'Row', summary: 'three, four', values: 'a: 3\nb: 4\nnote: three, four'}, updatedAt: ''});
		expect(calls[1]?.params).toEqual(['3', '4']);
	});
});

describe('writes', () => {
	const mysqlUsers = [
		{name: 'id', type: 'int(11)', not_null: 1, default: null, key_position: 1, auto_increment: 1},
		{name: 'email', type: 'varchar(200)', not_null: 1, default: null, key_position: null, auto_increment: 0},
		{name: 'name', type: 'varchar(100)', not_null: 0, default: null, key_position: null, auto_increment: 0},
	];

	test('adds a row with the values written, reading it back by the id the database numbered', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [
			{match: 'FROM information_schema.columns c', result: {rows: mysqlUsers}},
			{match: 'INSERT INTO', result: {affected: 1, lastInsertId: '7'}},
			{match: 'SELECT * FROM `users` WHERE `id` = ?', result: {rows: [{id: 7, email: 'new@example.com', name: null}]}},
		];
		const record = (await sqlConnectors('mysql').tables.create(target('mysql', 'tables'), {values: 'email: new@example.com\nname:'}, 'users')).unwrap();
		expect(record.id).toBe('users:7');
		expect(record.values.values).toBe('id: 7\nemail: new@example.com');
		expect(calls[1]).toEqual({statement: 'INSERT INTO `users` (`email`) VALUES (?)', params: ['new@example.com']});
		expect(calls[2]?.params).toEqual(['7']);
	});

	test('changes only the columns written differently, an empty one to NULL, and answers the row', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [
			{match: 'format_type(', result: {rows: userColumns}},
			{match: 'SELECT * FROM "public"."users" WHERE "id" = $1', result: {rows: [{id: 3, email: 'user3@example.com', signed_up: null, notes: {plan: 'free'}}]}},
			{match: 'UPDATE', result: {rows: [{id: 3, email: 'user3@example.org', signed_up: null, notes: null}], affected: 1}},
		];
		const record = (await sqlConnectors('postgres').tables.update(target('postgres', 'tables'), 'public.users:3', {values: 'email: user3@example.org\nnotes:'})).unwrap();
		expect(calls[2]).toEqual({statement: 'UPDATE "public"."users" SET "email" = $1, "notes" = $2 WHERE "id" = $3 RETURNING *', params: ['user3@example.org', null, '3']});
		expect(record.values.values).toBe('id: 3\nemail: user3@example.org');

		calls.length = 0;
		const same = (await sqlConnectors('postgres').tables.update(target('postgres', 'tables'), 'public.users:3', {values: 'email: user3@example.com'})).unwrap();
		expect(same.id).toBe('public.users:3');
		expect(calls.some((call) => call.statement.startsWith('UPDATE'))).toBe(false);
	});

	test('a table without a primary key is read, never written to', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [{match: 'format_type(', result: {rows: [{name: 'name', type: 'text', not_null: false, default: null, key_position: null, auto_increment: false}]}}];
		const connector = sqlConnectors('postgres').tables;
		expect((await connector.create(target('postgres', 'tables'), {values: 'name: x'}, 'public.events')).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await connector.update(target('postgres', 'tables'), 'public.events:@1', {values: 'name: x'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await connector.remove(target('postgres', 'tables'), 'public.events:@1')).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect(calls.some((call) => /^(INSERT|UPDATE|DELETE)/.test(call.statement))).toBe(false);
	});

	test('deletes a row by its key; one already gone is not found', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [
			{match: 'format_type(', result: {rows: userColumns}},
			{match: 'DELETE', result: {affected: 1}},
		];
		expect((await sqlConnectors('postgres').tables.remove(target('postgres', 'tables'), 'public.users:3')).isOk()).toBe(true);
		expect(calls[1]).toEqual({statement: 'DELETE FROM "public"."users" WHERE "id" = $1', params: ['3']});

		answers[1] = {match: 'DELETE', result: {affected: 0}};
		expect((await sqlConnectors('postgres').tables.remove(target('postgres', 'tables'), 'public.users:3')).unwrapErr()).toMatchObject({kind: 'not_found'});
	});

	test('a column the table does not have, or a row with no table to go in, is turned down', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [{match: 'format_type(', result: {rows: userColumns}}];
		const connector = sqlConnectors('postgres').tables;
		expect((await connector.create(target('postgres', 'tables'), {values: 'nope: 1'}, 'public.users')).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await connector.create(target('postgres', 'tables'), {values: 'email: a@b.c'}, null)).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});
});

describe('queries', () => {
	test('runs one statement that reads in a read-only transaction, a page of rows as JSON lines', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		const rows = Array.from({length: 201}, (_, index) => ({id: index, at: new Date('2026-10-13T00:09:04.517Z'), n: null}));
		answers = [{match: 'FETCH 201 FROM agent_query', result: {rows}}];
		const run = sqlConnectors('postgres').queries.newCommands?.run;
		const record = (await run!(target('postgres', 'queries'), {sql: 'select id from users;'})).unwrap();
		expect(calls.map((call) => call.statement)).toEqual([
			'START TRANSACTION READ ONLY',
			'SET LOCAL statement_timeout = 30000',
			'DECLARE agent_query NO SCROLL CURSOR FOR select id from users',
			'FETCH 201 FROM agent_query',
			'ROLLBACK',
		]);
		expect(record?.values.sql).toBe('select id from users');
		expect(record?.values.rows).toBe('200 rows, more left out');
		expect(record?.values.result?.split('\n')).toHaveLength(200);
		expect(record?.values.result?.split('\n')[0]).toBe('{"id":0,"at":"2026-10-13T00:09:04.517Z","n":null}');
	});

	test('on MySQL, caps what a SELECT answers for the session instead, after a time limit by the server’s name', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		answers = [
			{match: 'VERSION()', result: {rows: [{version: '10.11.18-MariaDB'}]}},
			{match: 'select 1', result: {rows: [{one: 1}]}},
		];
		const record = (await sqlConnectors('mysql').queries.newCommands!.run!(target('mysql', 'queries'), {sql: 'select 1 as one'})).unwrap();
		expect(calls.map((call) => call.statement)).toEqual([
			'SELECT VERSION() AS version',
			'SET SESSION max_statement_time = 30',
			'SET SESSION sql_select_limit = 201',
			'START TRANSACTION READ ONLY',
			'select 1 as one',
			'ROLLBACK',
		]);
		expect(record?.values).toEqual({sql: 'select 1 as one', rows: '1 row', result: '{"one":1}'});
	});

	test('refuses what writes, or a second statement, before connecting', async () => {
		const {sqlConnectors} = await import('./sql-connector');
		const run = sqlConnectors('postgres').queries.newCommands!.run!;
		withSql.mockClear();
		expect((await run(target('postgres', 'queries'), {sql: 'delete from users'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await run(target('postgres', 'queries'), {sql: 'select 1; drop table users'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect(withSql).not.toHaveBeenCalled();
	});
});
