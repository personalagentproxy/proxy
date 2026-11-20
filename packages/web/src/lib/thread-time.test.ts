import {describe, expect, test} from 'bun:test';
import {marksTime, markedTime} from './thread-time';

// Local times, so the days are the same wherever the test runs.
const at = (day: number, hour: number, minute = 0, month = 10, year = 2026) =>
	new Date(year, month, day, hour, minute).toISOString();
const now = new Date(2026, 10, 20, 9, 30);

// Intl may put a narrow space before AM and PM.
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('marksTime', () => {
	test('marks the first message, and one after the thread was quiet half an hour', () => {
		expect(marksTime(undefined, at(20, 9))).toBe(true);
		expect(marksTime(at(20, 9), at(20, 9, 29))).toBe(false);
		expect(marksTime(at(20, 9), at(20, 9, 30))).toBe(true);
	});
});

describe('markedTime', () => {
	test('says today and yesterday by name, with the time', () => {
		expect(plain(markedTime(at(20, 8, 5), now))).toBe('Today 8:05 AM');
		expect(plain(markedTime(at(19, 14, 51), now))).toBe('Yesterday 2:51 PM');
	});

	test('says the weekday within the week, the date before it', () => {
		expect(plain(markedTime(at(17, 16, 24), now))).toBe('Tuesday 4:24 PM');
		expect(plain(markedTime(at(13, 16, 24), now))).toBe('Fri, Nov 13 at 4:24 PM');
	});

	test('says the year once it is not this one', () => {
		expect(plain(markedTime(at(30, 10, 0, 11, 2025), now))).toBe('Tue, Dec 30, 2025 at 10:00 AM');
	});
});
