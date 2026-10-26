import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest, googleWrite} from './google-client';

/**
 * The Calendar v3 calls the `events` and `availability` collections make, and the reading of their
 * answers: the calendars the account has in its list, and their events, each time a repeating event
 * comes round its own, as Google Calendar shows them; and when calendars are busy.
 */

const CALENDAR = 'https://www.googleapis.com/calendar/v3';

/** The events a page of a list holds. */
export const EVENTS_PAGE_SIZE = 50;

const calendarSchema = z.object({
	id: z.string(),
	summary: z.string().optional(),
	// The name the account gave a calendar shared with it.
	summaryOverride: z.string().optional(),
	description: z.string().optional(),
	primary: z.boolean().optional(),
	timeZone: z.string().optional(),
	// Whether Google Calendar shows it, as ticked in its list, and what the account may do in it:
	// `owner` or `writer` make events, `reader` sees them, `freeBusyReader` only when it is busy.
	selected: z.boolean().optional(),
	accessRole: z.string().optional(),
	backgroundColor: z.string().optional(),
});

export type GoogleCalendar = z.infer<typeof calendarSchema>;

const calendarListSchema = z.object({items: z.array(calendarSchema).optional()});

// A day for an all-day event, a time with its offset for any other.
const whenSchema = z.object({date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional()});

const attendeeSchema = z.object({
	email: z.string().optional(),
	displayName: z.string().optional(),
	responseStatus: z.string().optional(),
	// The account itself, the organizer, and a room or other resource booked for the event.
	self: z.boolean().optional(),
	organizer: z.boolean().optional(),
	resource: z.boolean().optional(),
	optional: z.boolean().optional(),
});

export type Attendee = z.infer<typeof attendeeSchema>;

const eventSchema = z.object({
	id: z.string(),
	status: z.string().optional(),
	htmlLink: z.string().optional(),
	summary: z.string().optional(),
	description: z.string().optional(),
	location: z.string().optional(),
	start: whenSchema.optional(),
	end: whenSchema.optional(),
	attendees: z.array(attendeeSchema).optional(),
	organizer: z.object({email: z.string().optional(), displayName: z.string().optional(), self: z.boolean().optional()}).optional(),
	// Set on each time a repeating event comes round.
	recurringEventId: z.string().optional(),
	hangoutLink: z.string().optional(),
	conferenceData: z.object({entryPoints: z.array(z.object({entryPointType: z.string().optional(), uri: z.string().optional()})).optional()}).optional(),
	updated: z.string().optional(),
});

export type GoogleEvent = z.infer<typeof eventSchema>;

const eventsSchema = z.object({items: z.array(eventSchema).optional(), nextPageToken: z.string().optional()});

/** A time as Google takes it: a day for an all-day event, else a time, with its offset or in `timeZone`. */
export type EventTime = {date: string} | {dateTime: string; timeZone?: string};

/** What an event is written with: only what changes, on an edit. */
export type EventWrite = {
	summary?: string;
	description?: string;
	location?: string;
	start?: EventTime;
	end?: EventTime;
	attendees?: Attendee[];
};

function calendarUrl(calendarId: string, rest = ''): URL {
	return new URL(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}${rest}`);
}

function eventUrl(calendarId: string, eventId: string, sendUpdates?: 'all' | 'none'): URL {
	const url = calendarUrl(calendarId, `/events/${encodeURIComponent(eventId)}`);
	if (sendUpdates) {
		url.searchParams.set('sendUpdates', sendUpdates);
	}
	return url;
}

/** The calendars in the account's list, as Google lists them. */
export async function listCalendars(accessToken: string): Promise<Result<GoogleCalendar[], ApiError>> {
	const url = new URL(`${CALENDAR}/users/me/calendarList`);
	url.searchParams.set('maxResults', '250');
	const answer = await googleRequest(accessToken, url, calendarListSchema);
	return answer.map(({items = []}) => items);
}

/** One calendar of the account's list, with its name and time zone. */
export function getCalendar(accessToken: string, calendarId: string): Promise<Result<GoogleCalendar, ApiError>> {
	return googleRequest(accessToken, new URL(`${CALENDAR}/users/me/calendarList/${encodeURIComponent(calendarId)}`), calendarSchema);
}

export type EventsQuery = {from: string; to?: string; search: string | null; page: string | null};

/**
 * A page of a calendar's events ending after `from`, and starting before `to` where it is given,
 * soonest first, matching `search` where there is one.
 */
export async function listEvents(accessToken: string, calendarId: string, args: EventsQuery): Promise<Result<{events: GoogleEvent[]; nextPage: string | null}, ApiError>> {
	const url = calendarUrl(calendarId, '/events');
	url.searchParams.set('singleEvents', 'true');
	url.searchParams.set('orderBy', 'startTime');
	url.searchParams.set('timeMin', args.from);
	if (args.to) {
		url.searchParams.set('timeMax', args.to);
	}
	url.searchParams.set('maxResults', String(EVENTS_PAGE_SIZE));
	if (args.search) {
		url.searchParams.set('q', args.search);
	}
	if (args.page) {
		url.searchParams.set('pageToken', args.page);
	}
	const answer = await googleRequest(accessToken, url, eventsSchema);
	return answer.map(({items = [], nextPageToken}) => ({events: items, nextPage: nextPageToken ?? null}));
}

export function getEvent(accessToken: string, calendarId: string, eventId: string): Promise<Result<GoogleEvent, ApiError>> {
	return googleRequest(accessToken, eventUrl(calendarId, eventId), eventSchema);
}

/** Makes an event; Google emails its guests the invitation when `sendUpdates` is `all`. */
export function insertEvent(accessToken: string, calendarId: string, event: EventWrite, sendUpdates: 'all' | 'none'): Promise<Result<GoogleEvent, ApiError>> {
	const url = calendarUrl(calendarId, '/events');
	url.searchParams.set('sendUpdates', sendUpdates);
	return googleWrite(accessToken, 'POST', url, event, eventSchema);
}

/** Changes what is given of an event, the rest as it is; a list given, such as the guests, replaces the event's. */
export function patchEvent(accessToken: string, calendarId: string, eventId: string, event: EventWrite, sendUpdates: 'all' | 'none'): Promise<Result<GoogleEvent, ApiError>> {
	return googleWrite(accessToken, 'PATCH', eventUrl(calendarId, eventId, sendUpdates), event, eventSchema);
}

const freeBusySchema = z.object({
	calendars: z
		.record(
			z.string(),
			z.object({
				busy: z.array(z.object({start: z.string(), end: z.string()})).optional(),
				// Why a calendar wasn't answered for, such as `notFound` for one the account can't see.
				errors: z.array(z.object({reason: z.string().optional()})).optional(),
			}),
		)
		.optional(),
});

export type FreeBusy = z.infer<typeof freeBusySchema>;

/** When each calendar given is busy between `from` and `to`, instants with their offsets, by the calendar's id as given. */
export function queryFreeBusy(accessToken: string, args: {from: string; to: string; calendars: string[]}): Promise<Result<FreeBusy, ApiError>> {
	const body = {timeMin: args.from, timeMax: args.to, items: args.calendars.map((id) => ({id}))};
	return googleWrite(accessToken, 'POST', new URL(`${CALENDAR}/freeBusy`), body, freeBusySchema);
}
