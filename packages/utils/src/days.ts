// Days as a calendar names them, `2026-10-16`, without a time or a clock, in the person's time
// zone: what the home page's widgets search since and ask about, and an all-day event's dates.

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** How many days the second day is after the first. */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
