import {describe, expect, test} from 'bun:test';

import {notionValues, propertyLines, readPropertyLines, shapeOfType, shapeOfValue} from './notion-properties';

describe('propertyLines', () => {
	test("writes each property on a line, lists joined, leaving out empty ones and what Notion doesn't resolve", () => {
		const lines = propertyLines({Status: 'Contacted', Size: 100, Contacts: ['https://app.notion.com/p/a', 'https://app.notion.com/p/b'], Notes: '', Last: 'formulaResult://x/y/z', Done: null});
		expect(lines).toBe('Status: Contacted\nSize: 100\nContacts: https://app.notion.com/p/a, https://app.notion.com/p/b');
	});
});

describe('readPropertyLines', () => {
	const names = ['Status', 'Status Details', 'Notes'];

	test('reads a value by the property it starts with, running on over the lines after it', () => {
		expect(readPropertyLines('Status: Contacted\nStatus Details: Sent on Monday\nNotes: first line\nsecond line: still notes\n', names).unwrap()).toEqual({
			Status: 'Contacted',
			'Status Details': 'Sent on Monday',
			Notes: 'first line\nsecond line: still notes\n',
		});
		expect(readPropertyLines('Status:', names).unwrap()).toEqual({Status: ''});
		expect(readPropertyLines('', names).unwrap()).toEqual({});
	});

	test('turns down a first line that is no property', () => {
		expect(readPropertyLines('Owner: Sam', names).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});
});

describe('notionValues', () => {
	test("writes a value the way Notion's page tools take it, and clears an empty one", () => {
		expect(notionValues('Status', 'text', ' Contacted ').unwrap()).toEqual({Status: 'Contacted'});
		expect(notionValues('Size', 'number', '120').unwrap()).toEqual({Size: 120});
		expect(notionValues('Size', 'number', 'many').isErr()).toBe(true);
		expect(notionValues('Contacts', 'list', 'https://app.notion.com/p/a, https://app.notion.com/p/b').unwrap()).toEqual({Contacts: ['https://app.notion.com/p/a', 'https://app.notion.com/p/b']});
		expect(notionValues('Due', 'date', '2026-10-09').unwrap()).toEqual({'date:Due:start': '2026-10-09', 'date:Due:is_datetime': 0});
		expect(notionValues('Notes', 'text', '').unwrap()).toEqual({Notes: null});
	});

	test("a property's shape comes from its type in the database, or from the value a page has", () => {
		expect([shapeOfType('multi_select'), shapeOfType('number'), shapeOfType('status'), shapeOfType('rollup'), shapeOfType('title')]).toEqual(['list', 'number', 'text', null, null]);
		expect([shapeOfValue(['a']), shapeOfValue(3), shapeOfValue('x')]).toEqual(['list', 'number', 'text']);
	});
});
