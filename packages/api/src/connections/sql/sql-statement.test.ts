import {describe, expect, test} from 'bun:test';

import {checkStatement} from './sql-statement';

describe('checkStatement', () => {
	test('takes one statement that reads, its trailing semicolon dropped', () => {
		expect(checkStatement('  select * from users;  ').unwrap()).toEqual({sql: 'select * from users', keyword: 'select'});
		expect(checkStatement('WITH x AS (select 1) SELECT * FROM x').unwrap().keyword).toBe('with');
		expect(checkStatement('show tables').unwrap().keyword).toBe('show');
		expect(checkStatement('EXPLAIN select 1').unwrap().keyword).toBe('explain');
		expect(checkStatement('describe users').unwrap().keyword).toBe('describe');
		expect(checkStatement('-- the users\nselect 1').unwrap().keyword).toBe('select');
		expect(checkStatement('/* all */ select 1').unwrap().keyword).toBe('select');
	});

	test('refuses what writes, or is nothing', () => {
		for (const sql of ['delete from users', 'insert into users values (1)', 'update users set a = 1', 'drop table users', 'create table x (a int)', 'call cleanup()', 'set session foo = 1', 'begin']) {
			expect(checkStatement(sql).unwrapErr(), sql).toMatchObject({kind: 'validation_error'});
		}
		expect(checkStatement('   ').unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect(checkStatement('; delete from users').unwrapErr()).toMatchObject({kind: 'validation_error'});
	});

	test('refuses a semicolon anywhere but at the end, wherever it hides', () => {
		const statements = [
			'select 1; delete from users',
			'select 1;; select 2',
			"select 'a'; drop table users",
			"select 'a'--;\n; drop table users",
			// Postgres: a dollar-quoted string, and a backslash that escapes nothing, close where a
			// reading of quotes that doesn't know them wouldn't.
			"SELECT $a$'$a$; COMMIT; DELETE FROM users; --'",
			"SELECT 'x\\'; COMMIT; DELETE FROM users; --'",
			// MySQL: a `#` comment hides the quote that would otherwise open a string.
			"SELECT 1 # '\n; COMMIT; DROP TABLE users; -- '",
			// Inside a string, an identifier or a comment, too.
			"select 'a;b' from users",
			'select "a;b" from users',
			'select 1 -- a; comment\nfrom users',
			'select 1 /* a; comment */ from users',
		];
		for (const sql of statements) {
			expect(checkStatement(sql).unwrapErr(), sql).toMatchObject({kind: 'validation_error', message: 'One statement at a time, with no semicolon inside it'});
		}
	});
});
