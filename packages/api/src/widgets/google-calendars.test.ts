import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const listCalendars = mock();
const listEvents = mock();

mock.module('../connections/google/google-client', () => ({callGoogle: (_connection: unknown, call: (token: string) => unknown) => call('token')}));
mock.module('../connections/google/calendar-api', () => ({listCalendars, listEvents}));

beforeEach(() => {
	mock.clearAllMocks();
});

describe('googleCalendars.agenda', () => {
	test('reads the calendars Google Calendar shows and their events, without the declined, Busy where only that is seen', async () => {
		listCalendars.mockResolvedValue(
			Ok([
				{id: 'me@work', summary: 'me@work', primary: true, accessRole: 'owner', backgroundColor: '#9fe1e7'},
				{id: 'team', summary: 'Team', selected: true, accessRole: 'writer'},
				{id: 'boss', summary: 'Boss', selected: true, accessRole: 'freeBusyReader'},
				{id: 'holidays', summary: 'Holidays', accessRole: 'reader'},
				{id: 'broken', summary: 'Broken', selected: true, accessRole: 'reader'},
			]),
		);
		listEvents.mockImplementation(async (_token: string, calendarId: string) => {
			if (calendarId === 'broken') {
				return Err(ApiErr.notFound('file'));
			}
			const events = {
				'me@work': [
					{id: 'standup', summary: 'Standup', start: {dateTime: '2026-10-15T09:30:00+02:00'}, end: {dateTime: '2026-10-15T09:45:00+02:00'}, htmlLink: 'https://calendar.google.com/standup'},
					{id: 'declined', summary: 'Skip', start: {dateTime: '2026-10-15T11:00:00+02:00'}, end: {dateTime: '2026-10-15T12:00:00+02:00'}, attendees: [{self: true, responseStatus: 'declined'}]},
				],
				team: [{id: 'offsite', summary: 'Offsite', start: {date: '2026-10-15'}, end: {date: '2026-10-16'}}],
				boss: [{id: 'x', start: {dateTime: '2026-10-15T14:00:00+02:00'}, end: {dateTime: '2026-10-15T15:00:00+02:00'}}],
			}[calendarId];
			return Ok({events: events ?? [], nextPage: null});
		});
		const {googleCalendars} = await import('./google-calendars');

		const range = {from: '2026-10-15T00:00:00+02:00', to: '2026-10-16T00:00:00+02:00'};
		const read = (await googleCalendars.agenda({connection: {id: 'work'}} as never, range)).unwrap();

		expect(listEvents).not.toHaveBeenCalledWith('token', 'holidays', expect.anything());
		expect(listEvents).toHaveBeenCalledWith('token', 'me@work', {...range, search: null, page: null});
		expect(read.calendars.map((calendar) => [calendar.id, calendar.primary, calendar.writable])).toEqual([
			['me@work', true, true],
			['team', false, true],
			['boss', false, false],
			['broken', false, false],
		]);
		expect(read.events.map((event) => [event.title, event.allDay])).toEqual([
			['Standup', false],
			['Offsite', true],
			['Busy', false],
		]);
		expect(read.events[0]?.link).toBe('https://calendar.google.com/standup');
	});
});

describe('googleCalendars.search', () => {
	test('searches every calendar shown for each search from the time on, but those only seen as busy, each event once, soonest first', async () => {
		listCalendars.mockResolvedValue(
			Ok([
				{id: 'me@work', summary: 'me@work', primary: true, accessRole: 'owner'},
				{id: 'team', summary: 'Team', selected: true, accessRole: 'writer'},
				{id: 'boss', summary: 'Boss', selected: true, accessRole: 'freeBusyReader'},
			]),
		);
		const oneOnOne = {id: '1on1_20261021', summary: 'Arne / Konsti', start: {dateTime: '2026-10-21T15:00:00+02:00'}, end: {dateTime: '2026-10-21T15:30:00+02:00'}};
		const lunch = {id: 'lunch', summary: 'Lunch', start: {dateTime: '2026-10-17T12:00:00+02:00'}, end: {dateTime: '2026-10-17T13:00:00+02:00'}};
		listEvents.mockImplementation(async (_token: string, calendarId: string, query: {search: string}) => {
			if (calendarId === 'me@work') {
				return Ok({events: query.search === 'arne' ? [oneOnOne] : [oneOnOne, lunch], nextPage: null});
			}
			return Ok({events: [], nextPage: null});
		});
		const {googleCalendars} = await import('./google-calendars');

		const from = '2026-10-16T00:00:00+02:00';
		const found = (await googleCalendars.search({connection: {id: 'work'}} as never, {from, searches: ['arne', 'arne@example.com']})).unwrap();

		expect(listEvents).toHaveBeenCalledTimes(4);
		expect(listEvents).toHaveBeenCalledWith('token', 'team', {from, search: 'arne@example.com', page: null});
		expect(listEvents).not.toHaveBeenCalledWith('token', 'boss', expect.anything());
		expect(found.map((event) => event.title)).toEqual(['Lunch', 'Arne / Konsti']);
	});
});
