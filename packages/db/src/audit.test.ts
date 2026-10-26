import {describe, expect, test} from 'bun:test';

import {fairShare} from './audit';

describe('fairShare', () => {
	test('keeps every request where they all fit', () => {
		expect(fairShare([3, 5, 2], 10)).toBeNull();
		expect(fairShare([], 10)).toBeNull();
	});

	test('cuts only the tasks with more than their share, to their newest of it', () => {
		// The two small tasks keep theirs; the busy one keeps what is left.
		expect(fairShare([1, 1000, 1], 10)).toBe(8);
		expect(fairShare([50, 50, 50, 2], 100)).toBe(32);
	});

	test('keeps at least one of each', () => {
		expect(fairShare([5, 5, 5], 2)).toBe(1);
	});
});
