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

	test('refuses a second statement after a semicolon, wherever it hides', () => {
		expect(checkStatement('select 1; delete from users').unwrapErr()).toMatchObject({kind: 'validation_error', message: 'One statement at a time'});
		expect(checkStatement('select 1;; select 2').unwrapErr()).toMatchObject({kind: 'validation_error', message: 'One statement at a time'});
		expect(checkStatement("select 'a'; drop table users").unwrapErr()).toMatchObject({kind: 'validation_error', message: 'One statement at a time'});
		expect(checkStatement("select 'a'--;\n; drop table users").unwrapErr()).toMatchObject({kind: 'validation_error', message: 'One statement at a time'});
	});

	test('lets a semicolon in a string, an identifier or a comment through', () => {
		expect(checkStatement("select 'a;b', 'it''s; fine', 'back\\'; slash' from users").isOk()).toBe(true);
		expect(checkStatement('select "a;b" from `t;x`').isOk()).toBe(true);
		expect(checkStatement('select 1 -- a; comment\nfrom users').isOk()).toBe(true);
		expect(checkStatement('select 1 /* a; comment */ from users').isOk()).toBe(true);
	});
});
