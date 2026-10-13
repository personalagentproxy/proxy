import {describe, expect, test} from 'bun:test';

import {readValueLines, valueLines} from './value-lines';

describe('valueLines', () => {
	test('writes each value on a line, leaving out empty ones', () => {
		expect(
			valueLines([
				['Status', 'Contacted'],
				['Notes', ''],
				['Size', '100'],
			]),
		).toBe('Status: Contacted\nSize: 100');
	});
});

describe('readValueLines', () => {
	const names = ['Status', 'Status Details', 'Notes'];

	test('reads a value by the name it starts with, running on over the lines after it', () => {
		expect(readValueLines('Status: Contacted\nStatus Details: Sent on Monday\nNotes: first line\nsecond line: still notes\n', names).unwrap()).toEqual({
			Status: 'Contacted',
			'Status Details': 'Sent on Monday',
			Notes: 'first line\nsecond line: still notes\n',
		});
		expect(readValueLines('Status:', names).unwrap()).toEqual({Status: ''});
		expect(readValueLines('', names).unwrap()).toEqual({});
	});

	test('turns down a first line that is no name', () => {
		expect(readValueLines('Owner: Sam', names).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});
});
