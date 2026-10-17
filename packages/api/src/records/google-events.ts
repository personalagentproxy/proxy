import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {addDays} from '@proxy/utils/days';

import {
	getCalendar,
	getEvent,
	insertEvent,
	listCalendars,
	listEvents,
	patchEvent,
	type Attendee,
	type EventTime,
	type EventWrite,
	type GoogleCalendar,
	type GoogleEvent,
} from '../connections/google/calendar-api';
import {callGoogle} from '../connections/google/google-client';
import type {CommandRunner, Connector, DataRecord, ListQuery, RecordPage, RecordTarget, RecordValues} from './connector';
import {readPageToken, writePageToken} from './page-token';

/**
 * Google Calendar as the nested `events` collection, fetched live: at the top the calendars in the
 * account's list, the primary one first, and inside each its events from now on, soonest first, 50
 * to a page with Google's own page token, each time a repeating event comes round its own record.
 * A search is Google's, in titles, descriptions, locations and guests; one that begins with a day
 * lists from that day on instead of from now. At the top, a search is in the primary calendar.
 *
 * A calendar's record id is Google's calendar id; an event's is its calendar's and its own,
 * `alex@example.com:5g2…`, since an event is only found in its calendar. Times read as Google
 * writes them, with their offset, and a day alone for an all-day event, whose end reads as its
 * last day though Google keeps the day after. Times are written the same way, or without an offset
 * on the calendar's clock, in its time zone.
 *
 * An event's guests are told by Google of everything done to it: an event made or changed while it
 * has guests sends them Google's invitation or update, and one without them tells no one. Answering
 * an invitation tells its organizer. Events are never deleted here.
 */

// Google's event ids: base32hex for its own, other letters for an imported one's, and `_` with the
// time a repeating event comes round, `5g2…_20261015T120000Z`.
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

// Calendar ids are addresses, `alex@example.com` or `…@group.calendar.google.com`, with `#` in
// those Google keeps, such as a country's holidays; never a colon, which ends an event's calendar.
const CALENDAR_ID = /^[^\s:/?]{1,500}$/;

type EventRef = {calendarId: string; eventId: string};

function eventRecordId(calendarId: string, eventId: string): string {
	return `${calendarId}:${eventId}`;
}

function parseEventRef(recordId: string): EventRef | null {
	const colon = recordId.lastIndexOf(':');
	const calendarId = recordId.slice(0, colon);
	const eventId = recordId.slice(colon + 1);
	if (colon < 0 || !CALENDAR_ID.test(calendarId) || !EVENT_ID.test(eventId)) {
		return null;
	}
	return {calendarId, eventId};
}

function requireEventRef(recordId: string): Result<EventRef, ApiError> {
	const ref = parseEventRef(recordId);
	if (!ref) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(ref);
}

// A list opened inside a record, or an event made in one, is in a calendar: events hold nothing.
function requireCalendarId(recordId: string): Result<string, ApiError> {
	if (parseEventRef(recordId)) {
		return Err(ApiErr.validationError('Events hold nothing: give a calendar’s id as parent'));
	}
	if (!CALENDAR_ID.test(recordId)) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(recordId);
}

// Google says a calendar or event that isn't there is missing; the agent asked for a record.
function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

function requireCalendar(token: string, calendarId: string): Promise<Result<GoogleCalendar, ApiError>> {
	return getCalendar(token, calendarId).then((calendar) => calendar.mapErr(notFoundAs(calendarId)));
}

// A cancelled event is gone, though Google still answers for it.
function requireEvent(token: string, ref: EventRef, recordId: string): Promise<Result<GoogleEvent, ApiError>> {
	return Do(async ($) => {
		const event = $((await getEvent(token, ref.calendarId, ref.eventId)).mapErr(notFoundAs(recordId)));
		if (event.status === 'cancelled') {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		return event;
	});
}

const NEVER = new Date(0).toISOString();

function calendarTitle(calendar: GoogleCalendar): string {
	return calendar.summaryOverride ?? calendar.summary ?? calendar.id;
}

function calendarRecord(calendar: GoogleCalendar): DataRecord {
	return {id: calendar.id, values: {title: calendarTitle(calendar), kind: 'Calendar', description: calendar.description ?? ''}, updatedAt: NEVER, hasChildren: true};
}

// The primary calendar first, the rest as Google lists them.
function primaryFirst(calendars: GoogleCalendar[]): GoogleCalendar[] {
	return [...calendars.filter((calendar) => calendar.primary), ...calendars.filter((calendar) => !calendar.primary)];
}

const ANSWERS: Partial<Record<string, string>> = {needsAction: 'Needs action', accepted: 'Accepted', declined: 'Declined', tentative: 'Maybe'};

function answerOf(attendee: Attendee): string {
	return ANSWERS[attendee.responseStatus ?? ''] ?? 'Needs action';
}

function named(person: {email?: string; displayName?: string}): string {
	if (person.displayName && person.email) {
		return `${person.displayName} <${person.email}>`;
	}
	return person.email ?? person.displayName ?? '';
}

// Everyone invited but the account itself and the rooms booked.
function guestsOf(event: GoogleEvent): Attendee[] {
	return (event.attendees ?? []).filter((attendee) => !attendee.self && !attendee.resource && attendee.email);
}

function guestAddresses(event: GoogleEvent): string[] {
	return guestsOf(event).map((guest) => (guest.email ?? '').toLowerCase());
}

// The account's own answer, on an event someone else invited it to.
function responseOf(event: GoogleEvent): string {
	const self = event.attendees?.find((attendee) => attendee.self);
	if (!self || event.organizer?.self) {
		return '';
	}
	return answerOf(self);
}

function meetingOf(event: GoogleEvent): string {
	const video = event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video');
	return event.hangoutLink ?? video?.uri ?? '';
}

// An all-day event's end is the day after its last; it reads as its last.
function endText(event: GoogleEvent): string {
	if (event.end?.date) {
		return addDays(event.end.date, -1);
	}
	return event.end?.dateTime ?? '';
}

function eventValues(event: GoogleEvent): RecordValues {
	return {
		title: event.summary ?? '',
		kind: 'Event',
		start: event.start?.dateTime ?? event.start?.date ?? '',
		end: endText(event),
		location: event.location ?? '',
		guests: guestsOf(event)
			.map((guest) => guest.email ?? '')
			.join(', '),
		description: event.description ?? '',
		answers: guestsOf(event)
			.map((guest) => `${named(guest)}: ${answerOf(guest)}`)
			.join('\n'),
		response: responseOf(event),
		organizer: event.organizer?.self ? '' : named(event.organizer ?? {}),
		repeats: event.recurringEventId ? 'Yes' : '',
		meeting: meetingOf(event),
	};
}

function eventRecord(calendarId: string, event: GoogleEvent): DataRecord {
	return {id: eventRecordId(calendarId, event.id), values: eventValues(event), updatedAt: event.updated ?? NEVER, ...(event.htmlLink ? {url: event.htmlLink} : {})};
}

// A time as written: a day for an all-day event, or a time, with its offset or on the calendar's clock.
type Written = {kind: 'day'; date: string} | {kind: 'time'; dateTime: string; offset: boolean};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;

function realDay(day: string): boolean {
	return DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

function parseTime(label: string, text: string): Result<Written, ApiError> {
	const trimmed = text.trim();
	const refusal = ApiErr.validationError(
		`Write ${label} as a time, 2026-10-15T14:00, on the calendar’s clock or with an offset such as +02:00, or as a day, 2026-10-15, for an all-day event, not “${trimmed}”`,
	);
	if (realDay(trimmed)) {
		return Ok({kind: 'day', date: trimmed});
	}
	const [, day = '', hours = '', minutes = '', seconds = '00', offset] = TIME.exec(trimmed) ?? [];
	if (!realDay(day) || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
		return Err(refusal);
	}
	const dateTime = `${day}T${hours}:${minutes}:${seconds}`;
	if (offset === undefined) {
		return Ok({kind: 'time', dateTime, offset: false});
	}
	const zone = offset.toUpperCase() === 'Z' ? 'Z' : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
	return Ok({kind: 'time', dateTime: `${dateTime}${zone}`, offset: true});
}

const HOUR_MS = 3_600_000;

// A time moved by `ms`: as an instant where it has an offset, else on the calendar's clock.
function later(time: Extract<Written, {kind: 'time'}>, ms: number): Written {
	if (time.offset) {
		return {kind: 'time', dateTime: new Date(Date.parse(time.dateTime) + ms).toISOString().replace('.000Z', 'Z'), offset: true};
	}
	const moved = new Date(Date.parse(`${time.dateTime}Z`) + ms).toISOString().slice(0, 19);
	return {kind: 'time', dateTime: moved, offset: false};
}

// An event's end where none is written: an hour after its start, or the start's day.
function defaultEnd(start: Written): Written {
	if (start.kind === 'day') {
		return start;
	}
	return later(start, HOUR_MS);
}

// The end of an event moved to `start` without a new end: as long after it as before.
function movedEnd(start: Written, before: RecordValues): Written {
	const oldStart = parseTime('start', before.start ?? '');
	const oldEnd = parseTime('end', before.end ?? '');
	if (oldStart.isErr() || oldEnd.isErr()) {
		return defaultEnd(start);
	}
	const [from, to] = [oldStart.value, oldEnd.value];
	if (start.kind === 'day' && from.kind === 'day' && to.kind === 'day') {
		const days = (Date.parse(to.date) - Date.parse(from.date)) / (24 * HOUR_MS);
		return {kind: 'day', date: addDays(start.date, days)};
	}
	if (start.kind === 'time' && from.kind === 'time' && to.kind === 'time' && from.offset && to.offset) {
		return later(start, Date.parse(to.dateTime) - Date.parse(from.dateTime));
	}
	return defaultEnd(start);
}

// As Google takes a time: a time on the calendar's clock goes with its time zone, and an all-day
// event's end is the day after its last.
function googleTime(time: Written, timeZone: string | undefined, end: boolean): EventTime {
	if (time.kind === 'day') {
		return {date: end ? addDays(time.date, 1) : time.date};
	}
	if (time.offset || !timeZone) {
		return {dateTime: time.dateTime};
	}
	return {dateTime: time.dateTime, timeZone};
}

// The end written, else one kept as it was moving with the start, else the one a new event gets.
function endOf(values: RecordValues, before: RecordValues | null, start: Written): Result<Written, ApiError> {
	if (before !== null && values.end === before.end) {
		return Ok(movedEnd(start, before));
	}
	if ((values.end ?? '').trim() === '') {
		return Ok(defaultEnd(start));
	}
	return parseTime('end', values.end ?? '');
}

function startAndEnd(values: RecordValues, before: RecordValues | null, calendar: GoogleCalendar): Result<Pick<EventWrite, 'start' | 'end'>, ApiError> {
	if ((values.start ?? '').trim() === '') {
		return Err(ApiErr.validationError('Say when the event starts as start: 2026-10-15T14:00, or 2026-10-15 for an all-day event'));
	}
	return parseTime('start', values.start ?? '').andThen((start) =>
		endOf(values, before, start).andThen((end) => {
			if (start.kind !== end.kind) {
				return Err(ApiErr.validationError('Write start and end both as days, for an all-day event, or both as times'));
			}
			return Ok({start: googleTime(start, calendar.timeZone, false), end: googleTime(end, calendar.timeZone, true)});
		}),
	);
}

const ADDRESS = /^[^\s@<>(),;"']+@[^\s@<>(),;"']+\.[^\s@<>(),;"']+$/;

// The guests written, by their addresses, comma-separated; `Sam Lee <sam@example.com>` is taken too.
function parseGuests(text: string): Result<string[], ApiError> {
	const addresses: string[] = [];
	for (const part of text
		.split(/[,;\n]/)
		.map((one) => one.trim())
		.filter(Boolean)) {
		const address = (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase();
		if (!ADDRESS.test(address)) {
			return Err(ApiErr.validationError(`Write each guest as their email address, not “${part}”`));
		}
		if (!addresses.includes(address)) {
			addresses.push(address);
		}
	}
	return Ok(addresses);
}

function sameGuests(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((address) => b.includes(address));
}

// The event's attendees with the guests written: the account and rooms kept, a guest still invited
// kept with their answer, and the new ones added.
function withGuests(event: GoogleEvent | null, guests: string[]): Attendee[] {
	const attendees = event?.attendees ?? [];
	const kept = attendees.filter((attendee) => attendee.self || attendee.resource || guests.includes((attendee.email ?? '').toLowerCase()));
	const known = kept.map((attendee) => (attendee.email ?? '').toLowerCase());
	return [...kept, ...guests.filter((address) => !known.includes(address)).map((email) => ({email}))];
}

// What a list's next page carries: where the list began, since "now" moves, and Google's token.
const pageSchema = z.object({from: z.string(), token: z.string()});

function readPage(page: string | null): Result<z.infer<typeof pageSchema> | null, ApiError> {
	if (page === null) {
		return Ok(null);
	}
	return readPageToken(pageSchema, page);
}

// How far ahead of UTC a time zone's clock is at an instant.
function offsetMs(instant: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'}).formatToParts(
		instant,
	);
	const part = (type: string) => Number(parts.find((one) => one.type === type)?.value ?? 0);
	const clock = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
	return clock - Math.floor(instant / 1000) * 1000;
}

// The instant a day begins in a time zone, UTC's where the calendar has none Intl knows.
function dayStart(day: string, timeZone: string | undefined): string {
	const midnight = Date.parse(`${day}T00:00:00Z`);
	const shifted = Result.wrap(() => {
		const zone = timeZone ?? 'UTC';
		const guess = midnight - offsetMs(midnight, zone);
		return midnight - offsetMs(guess, zone);
	});
	return new Date(shifted.unwrapOr(midnight)).toISOString();
}

// A search that begins with a day lists from that day on, its words searched for after it.
const DAY_SEARCH = /^(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/;

function readSearch(search: string | null, calendar: GoogleCalendar): {from: string; words: string | null} {
	const [, day, words] = DAY_SEARCH.exec(search ?? '') ?? [];
	if (day && realDay(day)) {
		return {from: dayStart(day, calendar.timeZone), words: words?.trim() || null};
	}
	return {from: new Date().toISOString(), words: search};
}

/** The calendars, or a page of one calendar's events from now on, or from the day a search begins with. */
function listEventsTree(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			if (query.parent === null && query.search === null) {
				const calendars = $(await listCalendars(token));
				return {records: primaryFirst(calendars).map(calendarRecord), nextPage: null};
			}
			const calendar = $(await requireCalendar(token, query.parent === null ? 'primary' : $(requireCalendarId(query.parent))));
			const page = $(readPage(query.page));
			const search = readSearch(query.search, calendar);
			const from = page?.from ?? search.from;
			const answer = $(await listEvents(token, calendar.id, {from, search: search.words, page: page?.token ?? null}));
			const trail = query.parent === null ? {} : {trail: [{id: calendar.id, title: calendarTitle(calendar)}]};
			return {records: answer.events.map((event) => eventRecord(calendar.id, event)), nextPage: answer.nextPage ? writePageToken({from, token: answer.nextPage}) : null, ...trail};
		}),
	);
}

function getEventsRecord(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const ref = parseEventRef(recordId);
			if (!ref) {
				return calendarRecord($(await requireCalendar(token, $(requireCalendarId(recordId)))));
			}
			return eventRecord(ref.calendarId, $(await requireEvent(token, ref, recordId)));
		}),
	);
}

function optional(text: string | undefined): string | undefined {
	return text?.trim() ? text : undefined;
}

/** An event in the calendar given, or the primary one; Google invites its guests where it has any. */
function createEvent(target: RecordTarget, values: RecordValues, parent: string | null): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const calendar = $(await requireCalendar(token, parent === null ? 'primary' : $(requireCalendarId(parent))));
			const times = $(startAndEnd(values, null, calendar));
			const guests = $(parseGuests(values.guests ?? ''));
			const event: EventWrite = {
				summary: values.title?.trim() ?? '',
				description: optional(values.description),
				location: optional(values.location),
				...times,
				...(guests.length > 0 ? {attendees: withGuests(null, guests)} : {}),
			};
			const made = $(await insertEvent(token, calendar.id, event, guests.length > 0 ? 'all' : 'none'));
			return eventRecord(calendar.id, made);
		}),
	);
}

/**
 * Changes what was written differently: the title, description and location, the times, an end
 * kept moving with its start, and the guests. Google tells the guests of an event that has any,
 * before the change or after it.
 */
function updateEvent(target: RecordTarget, recordId: string, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const ref = $(requireEventRef(recordId));
			const event = $(await requireEvent(token, ref, recordId));
			const before = eventValues(event);
			const changed = (key: string) => (values[key] ?? '') !== (before[key] ?? '');
			const changes: EventWrite = {};
			if (changed('title')) {
				changes.summary = values.title ?? '';
			}
			if (changed('description')) {
				changes.description = values.description ?? '';
			}
			if (changed('location')) {
				changes.location = values.location ?? '';
			}
			if (changed('start') || changed('end')) {
				Object.assign(changes, $(startAndEnd(values, before, $(await requireCalendar(token, ref.calendarId)))));
			}
			const had = guestAddresses(event);
			const guests = $(parseGuests(values.guests ?? ''));
			if (!sameGuests(had, guests)) {
				changes.attendees = withGuests(event, guests);
			}
			if (Object.keys(changes).length === 0) {
				return eventRecord(ref.calendarId, event);
			}
			const tell = had.length > 0 || guests.length > 0 ? 'all' : 'none';
			return eventRecord(ref.calendarId, $(await patchEvent(token, ref.calendarId, ref.eventId, changes, tell)));
		}),
	);
}

// The account's answer to an invitation, which Google tells the organizer.
function respond(answer: 'accepted' | 'declined' | 'tentative'): CommandRunner {
	return (target, recordId) =>
		callGoogle(target.connection, (token) =>
			Do(async ($) => {
				const ref = $(requireEventRef(recordId));
				const event = $(await requireEvent(token, ref, recordId));
				if (responseOf(event) === '') {
					return $(Err(ApiErr.validationError('Only an event someone else invited you to is answered')));
				}
				const attendees = (event.attendees ?? []).map((attendee) => (attendee.self ? {...attendee, responseStatus: answer} : attendee));
				return eventRecord(ref.calendarId, $(await patchEvent(token, ref.calendarId, ref.eventId, {attendees}, 'all')));
			}),
		);
}

function notDeleted(): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Events in Google Calendar are never deleted here')));
}

export const eventsConnector: Connector = {
	list: listEventsTree,
	get: getEventsRecord,
	create: createEvent,
	update: updateEvent,
	remove: notDeleted,
	commands: {accept: respond('accepted'), decline: respond('declined'), maybe: respond('tentative')},
};
