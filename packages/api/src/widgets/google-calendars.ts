import {Do} from '@proxy/utils';

import {listCalendars, listEvents, type GoogleCalendar, type GoogleEvent} from '../connections/google/calendar-api';
import {callGoogle} from '../connections/google/google-client';
import {log} from '../observability/log';
import type {AgendaCalendar, AgendaEvent, CalendarAdapter} from './agenda';

/**
 * Google Calendar for the agenda: the calendars Google Calendar shows, ticked in its list, and
 * their events in the range, each time a repeating event comes round its own. Events the account
 * declined are left out, as Google Calendar fades them; a calendar it only sees as free or busy
 * shows its events as Busy. One calendar Google won't list the events of is left out too, rather
 * than the account's whole day.
 */

// A person ticks a dozen calendars at most; past that, the rest wait on the first.
const MAX_CALENDARS = 12;

function calendarOf(connectionId: string, calendar: GoogleCalendar): AgendaCalendar {
	return {
		connectionId,
		id: calendar.id,
		name: calendar.summaryOverride ?? calendar.summary ?? calendar.id,
		primary: calendar.primary === true,
		writable: calendar.accessRole === 'owner' || calendar.accessRole === 'writer',
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
	return [{connectionId, calendarId: calendar.id, id: event.id, title, start, end, allDay: event.start?.date !== undefined, link: event.htmlLink ?? null}];
}

export const googleCalendars: CalendarAdapter = (source, range) =>
	callGoogle(source.connection, (token) =>
		Do(async ($) => {
			const connectionId = source.connection.id;
			const shown = $(await listCalendars(token))
				.filter((calendar) => calendar.primary === true || calendar.selected === true)
				.slice(0, MAX_CALENDARS);
			const answers = await Promise.all(shown.map((calendar) => listEvents(token, calendar.id, {from: range.from, to: range.to, search: null, page: null})));
			const events = shown.flatMap((calendar, index) => {
				const answer = answers[index];
				if (answer?.isOk()) {
					return answer.value.events.flatMap((event) => eventOf(connectionId, calendar, event));
				}
				log.warn('A Google calendar’s events could not be listed', {connectionId, kind: answer?.isErr() ? answer.error.kind : null});
				return [];
			});
			return {calendars: shown.map((calendar) => calendarOf(connectionId, calendar)), events};
		}),
	);
