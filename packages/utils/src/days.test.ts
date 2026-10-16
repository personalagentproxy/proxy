import {describe, expect, test} from 'bun:test';

import {addDays, dayIn, daysBetween, isTimeZone, weekdayOf} from './days';

describe('days', () => {
	test('the day is the time zone’s, half-hour and quarter-hour offsets too', () => {
		const at = new Date('2026-10-15T23:30:00Z');
		expect(dayIn(at, 'UTC')).toBe('2026-10-15');
		expect(dayIn(at, 'Europe/Berlin')).toBe('2026-10-16');
		expect(dayIn(at, 'America/Los_Angeles')).toBe('2026-10-15');
		expect(dayIn(new Date('2026-10-15T18:10:00Z'), 'Asia/Kathmandu')).toBe('2026-10-15');
		expect(dayIn(new Date('2026-10-15T18:20:00Z'), 'Asia/Kathmandu')).toBe('2026-10-16');
	});

	test('adds days across months, years and leap days', () => {
		expect(addDays('2026-10-16', 1)).toBe('2026-10-17');
		expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
		expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
		expect(daysBetween('2026-10-01', '2026-10-16')).toBe(15);
		expect(daysBetween('2026-10-16', '2026-10-01')).toBe(-15);
	});

	test('weeks start on Monday', () => {
		expect(weekdayOf('2026-10-12')).toBe(0);
		expect(weekdayOf('2026-10-16')).toBe(4);
		expect(weekdayOf('2026-10-18')).toBe(6);
	});

	test('knows time zones and their aliases, and nothing else', () => {
		expect(isTimeZone('Europe/Berlin')).toBe(true);
		expect(isTimeZone('Asia/Calcutta')).toBe(true);
		expect(isTimeZone('UTC')).toBe(true);
		expect(isTimeZone('Mars/Olympus')).toBe(false);
		expect(isTimeZone("UTC'; DROP TABLE")).toBe(false);
	});
});
