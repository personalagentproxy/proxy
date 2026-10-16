import {Result} from 'ts-results-es';

// Days as a calendar names them, `2026-10-16`, without a time or a clock: what the activity graph
// counts by, in the person's time zone.

const DAY_MS = 24 * 60 * 60 * 1000;

// A time zone's name, `Europe/Berlin` or `UTC`. An offset such as `+05:00`, which the runtime takes
// too, isn't one: Postgres reads it the POSIX way, as five hours behind UTC rather than ahead.
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Whether the runtime knows the IANA time zone, such as `Europe/Berlin`, aliases included. */
export function isTimeZone(value: string): boolean {
	return (
		ZONE_NAME.test(value) &&
		Result.wrap(() => new Intl.DateTimeFormat('en-US', {timeZone: value})).isOk()
	);
}

/** The day it is at the instant on the time zone's clock. */
export function dayIn(at: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(at);
	const part = (type: 'year' | 'month' | 'day') =>
		parts.find((candidate) => candidate.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The day `count` days after (or, negative, before) it. */
export function addDays(day: string, count: number): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

/** The day of the week, 0 for Monday to 6 for Sunday. */
export function weekdayOf(day: string): number {
	return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** How many days the second day is after the first. */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
