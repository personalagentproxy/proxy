import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {addDays} from '@proxy/utils/days';

import {getCalendar, queryFreeBusy, type FreeBusy} from '../connections/google/calendar-api';
import {callGoogle} from '../connections/google/google-client';
import {clockTime, readTime, zonedInstant} from './calendar-time';
import type {NewCommandRunner, RunOnly} from './connector';

/**
 * When people are free, as the `availability` collection: never listed or opened, only checked.
 * Google's free/busy is asked of the account's primary calendar and those of the people named,
 * from From to To, from now and for a week where they are left out. A time without an offset is
 * on the primary calendar's clock and a day alone is the whole day, and every time answered is on
 * that clock. Someone whose calendar the account can't see is said to be so, never free, and left
 * out of the times everyone is free, which the answer says.
 */

const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;

// Google answers for 50 calendars at most; the account's own is one of them.
const MAX_PEOPLE = 49;

// The account's own calendar, as Google takes it and answers for it.
const PRIMARY = 'primary';

const ADDRESS = /^[^\s@<>(),;"']+@[^\s@<>(),;"']+\.[^\s@<>(),;"']+$/;

// The people written, by their addresses, comma-separated; `Sam Lee <sam@example.com>` is taken too.
function parsePeople(text: string, account: string): Result<string[], ApiError> {
	const addresses: string[] = [];
	for (const part of text
		.split(/[,;\n]/)
		.map((one) => one.trim())
		.filter(Boolean)) {
		const address = (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase();
		if (!ADDRESS.test(address)) {
			return Err(ApiErr.validationError(`Write each person as their email address, not “${part}”`));
		}
		if (address !== account.toLowerCase() && !addresses.includes(address)) {
			addresses.push(address);
		}
	}
	if (addresses.length > MAX_PEOPLE) {
		return Err(ApiErr.validationError(`Google checks ${MAX_PEOPLE} people at most at once, beside you`));
	}
	return Ok(addresses);
}

// An instant written as From or To: a day's start, or the next day's for To, a time with its
// offset, or one on the calendar's clock. Null where it was left out.
function parseBoundary(label: string, text: string, timeZone: string, end: boolean): Result<number | null, ApiError> {
	const trimmed = text.trim();
	if (trimmed === '') {
		return Ok(null);
	}
	const time = readTime(trimmed);
	if (!time) {
		return Err(ApiErr.validationError(`Write ${label} as a time, 2026-10-15T09:00, on your calendar’s clock or with an offset such as +02:00, or as a day, 2026-10-15, not “${trimmed}”`));
	}
	if (time.kind === 'day') {
		return Ok(Date.parse(zonedInstant(`${end ? addDays(time.date, 1) : time.date}T00:00:00`, timeZone)));
	}
	if (time.offset) {
		return Ok(Date.parse(time.dateTime));
	}
	return Ok(Date.parse(zonedInstant(time.dateTime, timeZone)));
}

type Span = {start: number; end: number};

// Spans in order, those that overlap or touch made one.
function merged(spans: Span[]): Span[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	return sorted.reduce<Span[]>((kept, span) => {
		const last = kept.at(-1);
		if (last && span.start <= last.end) {
			last.end = Math.max(last.end, span.end);
			return kept;
		}
		return [...kept, {...span}];
	}, []);
}

// "2026-10-15 09:00–10:00", or "2026-10-15 22:00 – 2026-10-16 01:00" across midnight.
function spanText(span: Span, timeZone: string): string {
	const start = clockTime(span.start, timeZone);
	const end = clockTime(span.end, timeZone);
	if (start.slice(0, 10) === end.slice(0, 10)) {
		return `${start}–${end.slice(11)}`;
	}
	return `${start} – ${end}`;
}

// The gaps between busy spans within the window.
function gaps(window: Span, busy: Span[]): Span[] {
	const free: Span[] = [];
	let from = window.start;
	for (const span of merged(busy)) {
		if (span.start > from) {
			free.push({start: from, end: Math.min(span.start, window.end)});
		}
		from = Math.max(from, span.end);
	}
	if (from < window.end) {
		free.push({start: from, end: window.end});
	}
	return free.filter((span) => span.end > span.start);
}

type Answer = {who: string; busy: Span[] | null};

// A calendar's busy spans within the window, by the first of its ids Google answered for, or null
// where Google couldn't say, as for a calendar the account can't see.
function answerFor(freeBusy: FreeBusy, calendars: string[], window: Span): Span[] | null {
	const answer = calendars.map((calendar) => freeBusy.calendars?.[calendar]).find(Boolean);
	if (!answer || (answer.errors ?? []).length > 0) {
		return null;
	}
	return (answer.busy ?? []).map((span) => ({start: Math.max(Date.parse(span.start), window.start), end: Math.min(Date.parse(span.end), window.end)})).filter((span) => span.end > span.start);
}

function busyLine(answer: Answer, timeZone: string): string {
	if (answer.busy === null) {
		return `${answer.who}: can’t see this calendar`;
	}
	if (answer.busy.length === 0) {
		return `${answer.who}: free`;
	}
	return `${answer.who}: ${merged(answer.busy)
		.map((span) => spanText(span, timeZone))
		.join(', ')}`;
}

function freeText(answers: Answer[], window: Span, timeZone: string): string {
	const seen = answers.flatMap((answer) => (answer.busy === null ? [] : [answer.busy]));
	const free = gaps(window, seen.flat());
	const lines = free.length > 0 ? free.map((span) => spanText(span, timeZone)) : ['No time when everyone is free'];
	const unseen = answers.filter((answer) => answer.busy === null).map((answer) => answer.who);
	if (unseen.length > 0) {
		lines.push(`Not counting ${unseen.join(', ')}, whose calendar can’t be seen`);
	}
	return lines.join('\n');
}

/** When the account and the people named are busy, and when all of them are free. */
const check: NewCommandRunner = (target, values) =>
	callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const account = target.connection.account;
			const people = $(parsePeople(values.people ?? '', account));
			const timeZone = $(await getCalendar(token, PRIMARY)).timeZone ?? 'UTC';
			const start = $(parseBoundary('from', values.from ?? '', timeZone, false)) ?? Date.now();
			const end = $(parseBoundary('to', values.to ?? '', timeZone, true)) ?? start + WEEK_MS;
			if (end <= start) {
				return $(Err(ApiErr.validationError('Write a to that is after from')));
			}
			const window = {start, end};
			const freeBusy = $(await queryFreeBusy(token, {from: new Date(start).toISOString(), to: new Date(end).toISOString(), calendars: [PRIMARY, ...people]}));
			// Google answers for the account's own calendar as it was asked for, or by its address.
			const own = {who: `You (${account})`, busy: answerFor(freeBusy, [PRIMARY, account.toLowerCase()], window)};
			const answers: Answer[] = [own, ...people.map((person) => ({who: person, busy: answerFor(freeBusy, [person], window)}))];
			return {
				id: 'availability',
				values: {
					people: people.join(', '),
					from: clockTime(start, timeZone),
					to: clockTime(end, timeZone),
					timeZone,
					busy: answers.map((answer) => busyLine(answer, timeZone)).join('\n'),
					free: freeText(answers, window, timeZone),
				},
				updatedAt: new Date().toISOString(),
			};
		}),
	);

export const availabilityConnector = {newCommands: {check}} satisfies RunOnly;
