/// <reference types="bun" />

import {describe, expect, test} from 'bun:test';
import {formatMessageTime} from '@/lib/chat-time';

// A moment in the browser's own time zone, as the page counts days in it.
function at(month: number, day: number, hour: number, minute = 0, year = 2026): string {
	return new Date(year, month - 1, day, hour, minute).toISOString();
}

const now = new Date(2026, 9, 21, 15, 0);

describe('formatMessageTime', () => {
	test('gives today the time alone, and names yesterday', () => {
		expect(formatMessageTime(at(10, 21, 9, 5), now)).toBe('9:05 AM');
		expect(formatMessageTime(at(10, 20, 23, 30), now)).toBe('Yesterday 11:30 PM');
	});

	test('gives an earlier day with its weekday, and the year once it is not this one', () => {
		expect(formatMessageTime(at(9, 26, 3), now)).toBe('Sat, Sep 26 3:00 AM');
		expect(formatMessageTime(at(12, 31, 18, 0, 2025), now)).toBe('Wed, Dec 31, 2025 6:00 PM');
	});
});
