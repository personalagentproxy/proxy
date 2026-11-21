import {describe, expect, test} from 'bun:test';

import {diffLines} from './line-diff';

describe('diffLines', () => {
	test('a line changed shows as taken out and put in, between the lines both have', () => {
		expect(diffLines('Title\nold line\nend\n', 'Title\nnew line\nend\n')).toEqual([
			{kind: 'same', text: 'Title'},
			{kind: 'removed', text: 'old line'},
			{kind: 'added', text: 'new line'},
			{kind: 'same', text: 'end'},
		]);
	});

	test('a new note is all put in', () => {
		expect(diffLines('', 'one\ntwo')).toEqual([
			{kind: 'added', text: 'one'},
			{kind: 'added', text: 'two'},
		]);
	});

	test('lines added at the end keep those before as they are', () => {
		expect(diffLines('a\nb', 'a\nb\nc')).toEqual([
			{kind: 'same', text: 'a'},
			{kind: 'same', text: 'b'},
			{kind: 'added', text: 'c'},
		]);
	});
});
