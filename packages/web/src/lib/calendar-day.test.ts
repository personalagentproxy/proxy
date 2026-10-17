import {describe, expect, test} from 'bun:test';
import {searchFrom} from '@/lib/calendar-day';

// Wednesday 14 October 2026, 14:30 local time.
const now = new Date(2026, 9, 14, 14, 30, 42);

describe('searchFrom', () => {
	test('searches from the minute it is, so a meeting over this morning is not the next one', () => {
		expect(searchFrom(null, now)).toEqual(new Date(2026, 9, 14, 14, 30));
	});

	test('searches from the midnight of a day asked about', () => {
		expect(searchFrom(new Date(2026, 9, 16, 9), now)).toEqual(new Date(2026, 9, 16));
	});
});
