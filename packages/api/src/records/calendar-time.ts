import {Result} from 'ts-results-es';

/**
 * Times as agents write them for Google Calendar, and a time zone's clock: a day alone,
 * `2026-10-15`, or a time, `2026-10-15T14:00`, with an offset or on a calendar's clock.
 */

/** A time as written: a day alone, or a time, with its offset or on the calendar's clock. */
export type Written = {kind: 'day'; date: string} | {kind: 'time'; dateTime: string; offset: boolean};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** A day that is on the calendar, 2026-10-15, not 2026-02-30. */
export function realDay(day: string): boolean {
	return DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

/** A day or a time as written, its offset written as Google takes it, `+02:00` or `Z`; null for anything else. */
export function readTime(text: string): Written | null {
	const trimmed = text.trim();
	if (realDay(trimmed)) {
		return {kind: 'day', date: trimmed};
	}
	const [, day = '', hours = '', minutes = '', seconds = '00', offset] = TIME.exec(trimmed) ?? [];
	if (!realDay(day) || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
		return null;
	}
	const dateTime = `${day}T${hours}:${minutes}:${seconds}`;
	if (offset === undefined) {
		return {kind: 'time', dateTime, offset: false};
	}
	const zone = offset.toUpperCase() === 'Z' ? 'Z' : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
	return {kind: 'time', dateTime: `${dateTime}${zone}`, offset: true};
}

// A time zone's clock at an instant, as the parts Intl formats it in.
function clockParts(instant: number, timeZone: string): Record<string, number> {
	const parts = new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'}).formatToParts(
		instant,
	);
	return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

// How far ahead of UTC a time zone's clock is at an instant.
function offsetMs(instant: number, timeZone: string): number {
	const part = clockParts(instant, timeZone);
	const clock = Date.UTC(part.year ?? 1970, (part.month ?? 1) - 1, part.day ?? 1, part.hour ?? 0, part.minute ?? 0, part.second ?? 0);
	return clock - Math.floor(instant / 1000) * 1000;
}

/** The instant a time on a time zone's clock is, `2026-10-15T09:00:00`, UTC's where the zone is none Intl knows. */
export function zonedInstant(clock: string, timeZone: string | undefined): string {
	const asUtc = Date.parse(`${clock}Z`);
	const shifted = Result.wrap(() => {
		const zone = timeZone ?? 'UTC';
		const guess = asUtc - offsetMs(asUtc, zone);
		return asUtc - offsetMs(guess, zone);
	});
	return new Date(shifted.unwrapOr(asUtc)).toISOString();
}

const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');

/** An instant as a time zone's clock shows it, `2026-10-15 09:00`, UTC's where the zone is none Intl knows. */
export function clockTime(instant: number, timeZone: string): string {
	const part = Result.wrap(() => clockParts(instant, timeZone)).unwrapOr(clockParts(instant, 'UTC'));
	return `${part.year}-${pad(part.month)}-${pad(part.day)} ${pad(part.hour)}:${pad(part.minute)}`;
}
