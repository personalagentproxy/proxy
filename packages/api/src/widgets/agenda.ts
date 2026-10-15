import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {getWriteTarget} from '@proxy/db/write-target';
import type {IntegrationId} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import {eachSource, type Failure} from './each-source';
import {googleCalendars} from './google-calendars';
import {findSources, summarize, type Source, type SourceSummary} from './sources';

/**
 * A stretch of time in every calendar connected, for the New event widget: the day an event is
 * for, with what is already in it, and the calendars a new event can go in, the one the person
 * last made one in first.
 */

/** A calendar as the widget shows it: whose, and whether a new event can go in it. */
export type AgendaCalendar = {connectionId: string; id: string; name: string; primary: boolean; writable: boolean; color: string | null};

/**
 * An event of a calendar: its times with their offsets, or for an all-day event its first day and
 * the day after its last.
 */
export type AgendaEvent = {connectionId: string; calendarId: string; id: string; title: string; start: string; end: string; allDay: boolean; link: string | null};

/** How an integration's calendars are read; a calendar integration joins the widget with one. */
export type CalendarAdapter = (source: Source, range: {from: string; to: string}) => Promise<Result<{calendars: AgendaCalendar[]; events: AgendaEvent[]}, ApiError>>;

const ADAPTERS: Partial<Record<IntegrationId, CalendarAdapter>> = {google: googleCalendars};

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
		const orgId = $(await requireUserOrgId(request));
		const sources = $(await findSources(orgId, 'events', 'list')).flatMap((source) => {
			const adapter = ADAPTERS[source.integration.id];
			return adapter ? [{...source, adapter}] : [];
		});
		const {found, failed} = await eachSource(sources, (source) => source.adapter(source, range));
		const calendars = found.flatMap(({value}) => value.calendars);
		const events = found.flatMap(({value}) => value.events).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
		const last = $(await getWriteTarget(request.user.userId, 'events'));
		return {sources: sources.map(summarize), calendars, events, target: pickTarget(calendars, last), failed};
	});
}
