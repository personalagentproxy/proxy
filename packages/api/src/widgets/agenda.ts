import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {getWriteTarget} from '@proxy/db/write-target';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import type {Calendar, CalendarEvent} from '../records/capabilities';
import {eachSource, type Failure} from './each-source';
import {findSources, summarize, withCapability, type SourceSummary} from './sources';

/**
 * Every calendar connected, for the New event and Calendar widgets: a stretch of time, the day an
 * event is for or the day asked about, with what is in it, and the calendars a new event can go in,
 * the one the person last made one in first; and the events coming up that a search finds, each
 * through the `events` connector's agenda and search.
 */

/** A calendar as the widget shows it: whose, and whether a new event can go in it. */
export type AgendaCalendar = {connectionId: string} & Calendar;

/** An event of a calendar, and whose. */
export type AgendaEvent = {connectionId: string} & CalendarEvent;

export type CalendarTarget = {connectionId: string; calendarId: string};

export type Agenda = {sources: SourceSummary[]; calendars: AgendaCalendar[]; events: AgendaEvent[]; target: CalendarTarget | null; failed: Failure[]};

// A widget shows a day, or two where an event runs past midnight.
const MAX_RANGE_MS = 2 * 24 * 3_600_000;

const querySchema = z.object({from: z.iso.datetime({offset: true}), to: z.iso.datetime({offset: true})});

/**
 * Where a new event goes: the calendar the person last made one in, while they still can, else the
 * first primary calendar they can write to, else any.
 */
export function pickTarget(calendars: AgendaCalendar[], last: {connectionId: string; parent: string | null} | null): CalendarTarget | null {
	const writable = calendars.filter((calendar) => calendar.writable);
	const kept = writable.find((calendar) => calendar.connectionId === last?.connectionId && calendar.id === last.parent);
	const picked = kept ?? writable.find((calendar) => calendar.primary) ?? writable[0];
	return picked ? {connectionId: picked.connectionId, calendarId: picked.id} : null;
}

/** `GET /api/widgets/agenda?from=…&to=…`: every calendar's events between two times. */
export function handleAgendaRoute(request: AuthenticatedRequest): Promise<Result<Agenda, ApiError>> {
	return Do(async ($) => {
		const range = $(parseSchema(querySchema, request.query));
		const span = Date.parse(range.to) - Date.parse(range.from);
		if (span <= 0 || span > MAX_RANGE_MS) {
			return $(Err(ApiErr.validationError('Ask for at most two days, from before to')));
		}
		const viewer = $(await requireViewer(request));
		const sources = withCapability($(await findSources(viewer, 'events', 'list')), 'agenda');
		const {found, failed} = await eachSource(sources, (source) => source.connector.agenda(source, range));
		const calendars = found.flatMap(({source, value}) => value.calendars.map((calendar): AgendaCalendar => ({connectionId: source.connection.id, ...calendar})));
		const events = found
			.flatMap(({source, value}) => value.events.map((event): AgendaEvent => ({connectionId: source.connection.id, ...event})))
			.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
		const last = $(await getWriteTarget(request.user.userId, 'events'));
		return {sources: sources.map(summarize), calendars, events, target: pickTarget(calendars, last), failed};
	});
}

// What the Calendar widget lists at most, across every calendar.
const FOUND_LIMIT = 10;

const searchSchema = z.object({
	from: z.iso.datetime({offset: true}),
	// Each a search on its own, any of which finds an event: "arne", "arne@example.com".
	search: z
		.union([z.string(), z.array(z.string())])
		.transform((value) => [...new Set((Array.isArray(value) ? value : [value]).map((one) => one.trim().slice(0, 200)).filter((one) => one !== ''))])
		.pipe(z.array(z.string()).min(1).max(3)),
});

export type FoundEvents = {sources: SourceSummary[]; events: AgendaEvent[]; failed: Failure[]};

/**
 * `GET /api/widgets/events?from=…&search=…&search=…`: the events from a time on that any of the
 * searches finds in every calendar, as the calendar's own search finds them (in Google's, by
 * title, description, place and the guests' names and addresses), soonest first, each once.
 */
export function handleFindEventsRoute(request: AuthenticatedRequest): Promise<Result<FoundEvents, ApiError>> {
	return Do(async ($) => {
		const {from, search} = $(parseSchema(searchSchema, request.query));
		const viewer = $(await requireViewer(request));
		const sources = withCapability($(await findSources(viewer, 'events', 'list')), 'findEvents');
		const {found, failed} = await eachSource(sources, (source) => source.connector.findEvents(source, {from, searches: search}));
		const events = found
			.flatMap(({source, value}) => value.map((event): AgendaEvent => ({connectionId: source.connection.id, ...event})))
			.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
			.slice(0, FOUND_LIMIT);
		return {sources: sources.map(summarize), events, failed};
	});
}
