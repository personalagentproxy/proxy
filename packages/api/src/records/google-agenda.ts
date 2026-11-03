import {Err, Ok, type Result} from 'ts-results-es';

import {type ApiError, Do, mapWithLimit} from '@proxy/utils';

import {listCalendars, listEvents, type EventsQuery, type GoogleCalendar, type GoogleEvent} from '../connections/google/calendar-api';
import {callGoogle} from '../connections/google/google-client';
import {log} from '../observability/log';
import type {Agenda, Calendar, CalendarEvent} from './capabilities';
import type {RecordTarget} from './connector';

/**
 * Google Calendar for the widgets, as the `events` connector's agenda and search: the calendars
 * Google Calendar shows, ticked in its list, and their events in a range, or from a time on those
 * its search finds, each time a repeating event comes round its own. Events the account declined
 * are left out, as Google Calendar fades them; a calendar it only sees as free or busy shows its
 * events as Busy, and isn't searched, having nothing to search. One calendar Google won't list the
 * events of is left out too, rather than the account's whole day; Google out of reach or busy
 * fails the account, rather than leaving out what it would have found.
 */

// A person ticks a dozen calendars at most; past that, the rest wait on the first.
const MAX_CALENDARS = 12;

function writable(calendar: GoogleCalendar): boolean {
	return calendar.accessRole === 'owner' || calendar.accessRole === 'writer';
}

function calendarOf(calendar: GoogleCalendar): Calendar {
	return {
		id: calendar.id,
		name: calendar.summaryOverride ?? calendar.summary ?? calendar.id,
		primary: calendar.primary === true,
		writable: writable(calendar),
		color: calendar.backgroundColor ?? null,
	};
}

function declined(event: GoogleEvent): boolean {
	return event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined') === true;
}

function eventOf(calendar: GoogleCalendar, event: GoogleEvent): CalendarEvent[] {
	const start = event.start?.dateTime ?? event.start?.date;
	const end = event.end?.dateTime ?? event.end?.date;
	if (!start || !end || event.status === 'cancelled' || declined(event)) {
		return [];
	}
	const title = event.summary ?? (calendar.accessRole === 'freeBusyReader' ? 'Busy' : '(No title)');
	const guests = (event.attendees ?? []).flatMap((attendee) => (attendee.self || attendee.resource || !attendee.email ? [] : [attendee.email]));
	const editable = writable(calendar) && (event.organizer === undefined || event.organizer.self === true);
	return [
		{
			calendarId: calendar.id,
			id: event.id,
			title,
			start,
			end,
			allDay: event.start?.date !== undefined,
			location: event.location ?? '',
			guests,
			editable,
			link: event.htmlLink ?? null,
		},
	];
}

// The calendars Google Calendar shows: the primary one and those ticked in its list.
async function shownCalendars(token: string): Promise<Result<GoogleCalendar[], ApiError>> {
	return (await listCalendars(token)).map((calendars) => calendars.filter((calendar) => calendar.primary === true || calendar.selected === true).slice(0, MAX_CALENDARS));
}

type Asked = {calendar: GoogleCalendar; query: EventsQuery};

// Calendars asked at once: a dozen calendars, each searched three ways, is a burst Google turns down.
const ASKED_AT_ONCE = 6;

// Google out of reach, busy or turning the sign-in down fails the account, as a day or a search
// missing what it would have found isn't to be shown as all there is; a calendar Google refuses to
// list is left out.
function failsAccount(error: ApiError): boolean {
	return error.kind === 'provider_unreachable' || error.kind === 'credentials_rejected';
}

// The events each ask answers, those of a calendar Google wouldn't list left out.
async function eventsOf(token: string, connectionId: string, asks: Asked[]): Promise<Result<CalendarEvent[], ApiError>> {
	const answers = await mapWithLimit(asks, ASKED_AT_ONCE, ({calendar, query}) => listEvents(token, calendar.id, query));
	const failure = answers.find((answer) => answer.isErr() && failsAccount(answer.error));
	if (failure?.isErr()) {
		return Err(failure.error);
	}
	return Ok(
		asks.flatMap(({calendar}, index) => {
			const answer = answers[index];
			if (answer?.isOk()) {
				return answer.value.events.flatMap((event) => eventOf(calendar, event));
			}
			log.warn('A Google calendar’s events could not be listed', {connectionId, kind: answer?.isErr() ? answer.error.kind : null});
			return [];
		}),
	);
}

// Each event once, though two searches, or two calendars it is on, found it: the copy the person
// can change where one is, as on their own calendar beside a colleague's they only read.
function eachOnce(events: CalendarEvent[]): CalendarEvent[] {
	const kept = new Map<string, CalendarEvent>();
	events.forEach((event) => {
		const key = `${event.id} ${event.start}`;
		const had = kept.get(key);
		if (!had || (event.editable && !had.editable)) {
			kept.set(key, event);
		}
	});
	return [...kept.values()];
}

/** The calendars Google Calendar shows, and their events between two times. */
export function googleAgenda(target: RecordTarget, range: {from: string; to: string}): Promise<Result<Agenda, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const shown = $(await shownCalendars(token));
			const events = $(
				await eventsOf(
					token,
					target.connection.id,
					shown.map((calendar) => ({calendar, query: {from: range.from, to: range.to, search: null, page: null}})),
				),
			);
			return {calendars: shown.map(calendarOf), events: eachOnce(events)};
		}),
	);
}

/** The events from a time on that any of the searches finds in the calendars shown, soonest first, each once. */
export function findGoogleEvents(target: RecordTarget, {from, searches}: {from: string; searches: string[]}): Promise<Result<CalendarEvent[], ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const searched = $(await shownCalendars(token)).filter((calendar) => calendar.accessRole !== 'freeBusyReader');
			const asks = searched.flatMap((calendar) => searches.map((search) => ({calendar, query: {from, search, page: null}})));
			return eachOnce($(await eventsOf(token, target.connection.id, asks))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
		}),
	);
}
