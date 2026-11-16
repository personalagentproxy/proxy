import {describe, expect, test} from 'bun:test';
import {variablesSchema} from './variables';

describe('development variable validation', () => {
	test('preserves multiline and empty values', () => {
		expect(variablesSchema.parse({KEY: 'line1\nline2', EMPTY: ''})).toEqual({KEY: 'line1\nline2', EMPTY: ''});
	});
	test('rejects invalid process environment values', () => {
		for (const value of [{'INVALID-NAME': 'x'}, {KEY: 'a\0b'}, {KEY: 42}, Object.fromEntries(Array.from({length: 101}, (_, i) => ['KEY_' + i, 'x']))]) {
			expect(variablesSchema.safeParse(value).success).toBe(false);
		}
	});
});
