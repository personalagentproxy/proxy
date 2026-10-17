import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';

import {listCalendars, listEvents, type EventsQuery, type GoogleCalendar, type GoogleEvent} from '../connections/google/calendar-api';
import {callGoogle} from '../connections/google/google-client';
import {log} from '../observability/log';
import type {AgendaCalendar, AgendaEvent, CalendarAdapter} from './agenda';

/**
 * Google Calendar for the widgets: the calendars Google Calendar shows, ticked in its list, and
 * their events in a range, or from a time on those its search finds, each time a repeating event
 * comes round its own. Events the account declined are left out, as Google Calendar fades them; a
 * calendar it only sees as free or busy shows its events as Busy, and isn't searched, having
 * nothing to search. One calendar Google won't list the events of is left out too, rather than
 * the account's whole day.
 */

// A person ticks a dozen calendars at most; past that, the rest wait on the first.
const MAX_CALENDARS = 12;

function writable(calendar: GoogleCalendar): boolean {
	return calendar.accessRole === 'owner' || calendar.accessRole === 'writer';
}

function calendarOf(connectionId: string, calendar: GoogleCalendar): AgendaCalendar {
	return {
		connectionId,
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

function eventOf(connectionId: string, calendar: GoogleCalendar, event: GoogleEvent): AgendaEvent[] {
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
			connectionId,
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

// The events each ask answers, those Google wouldn't list left out.
async function eventsOf(token: string, connectionId: string, asks: Asked[]): Promise<AgendaEvent[]> {
	const answers = await Promise.all(asks.map(({calendar, query}) => listEvents(token, calendar.id, query)));
	return asks.flatMap(({calendar}, index) => {
		const answer = answers[index];
		if (answer?.isOk()) {
			return answer.value.events.flatMap((event) => eventOf(connectionId, calendar, event));
		}
		log.warn('A Google calendar’s events could not be listed', {connectionId, kind: answer?.isErr() ? answer.error.kind : null});
		return [];
	});
}

// Each event once, though two searches, or two calendars it is on, found it.
function eachOnce(events: AgendaEvent[]): AgendaEvent[] {
	const seen = new Set<string>();
	return events.filter((event) => {
		const key = `${event.id} ${event.start}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

export const googleCalendars: CalendarAdapter = {
	agenda: (source, range) =>
		callGoogle(source.connection, (token) =>
			Do(async ($) => {
				const connectionId = source.connection.id;
				const shown = $(await shownCalendars(token));
				const events = await eventsOf(
					token,
					connectionId,
					shown.map((calendar) => ({calendar, query: {from: range.from, to: range.to, search: null, page: null}})),
				);
				return {calendars: shown.map((calendar) => calendarOf(connectionId, calendar)), events};
			}),
		),
	search: (source, {from, searches}) =>
		callGoogle(source.connection, (token) =>
			Do(async ($) => {
				const searched = $(await shownCalendars(token)).filter((calendar) => calendar.accessRole !== 'freeBusyReader');
				const asks = searched.flatMap((calendar) => searches.map((search) => ({calendar, query: {from, search, page: null}})));
				return eachOnce(await eventsOf(token, source.connection.id, asks)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
			}),
		),
};
