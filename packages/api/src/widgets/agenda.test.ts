import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const findSources = mock();
const googleCalendars = {agenda: mock(), search: mock()};
const getWriteTarget = mock(async (): Promise<unknown> => Ok(null));

mock.module('./sources', () => ({findSources, summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id})}));
mock.module('./google-calendars', () => ({googleCalendars}));
mock.module('@proxy/db/write-target', () => ({getWriteTarget}));
mock.module('../utils/user-org', () => ({
	requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}),
}));

const calendar = (connectionId: string, id: string, primary: boolean, writable: boolean) => ({connectionId, id, name: id, primary, writable, color: null});

beforeEach(() => {
	mock.clearAllMocks();
	getWriteTarget.mockResolvedValue(Ok(null));
});

describe('pickTarget', () => {
	test('keeps the calendar last written to, else the first primary one written to, else any', async () => {
		const {pickTarget} = await import('./agenda');
		const calendars = [calendar('home', 'shared', false, false), calendar('home', 'team', false, true), calendar('work', 'me@work', true, true)];

		expect(pickTarget(calendars, {connectionId: 'home', parent: 'team'})).toEqual({connectionId: 'home', calendarId: 'team'});
		expect(pickTarget(calendars, null)).toEqual({connectionId: 'work', calendarId: 'me@work'});
		expect(pickTarget(calendars, {connectionId: 'home', parent: 'shared'})).toEqual({connectionId: 'work', calendarId: 'me@work'});
		expect(pickTarget([calendar('home', 'team', false, true)], null)).toEqual({connectionId: 'home', calendarId: 'team'});
		expect(pickTarget([calendar('home', 'shared', false, false)], null)).toBeNull();
	});
});

describe('handleAgendaRoute', () => {
	const from = '2026-10-15T00:00:00.000+02:00';
	const to = '2026-10-16T00:00:00.000+02:00';

	test('gathers every calendar integration with an adapter, soonest first', async () => {
		findSources.mockResolvedValue(
			Ok([
				{connection: {id: 'work'}, integration: {id: 'google'}},
				{connection: {id: 'other'}, integration: {id: 'notion'}},
			]),
		);
		googleCalendars.agenda.mockResolvedValue(
			Ok({
				calendars: [calendar('work', 'me@work', true, true)],
				events: [
					{connectionId: 'work', calendarId: 'me@work', id: 'b', title: 'Later', start: '2026-10-15T15:00:00+02:00', end: '2026-10-15T16:00:00+02:00', allDay: false, link: null},
					{connectionId: 'work', calendarId: 'me@work', id: 'a', title: 'Sooner', start: '2026-10-15T09:00:00+02:00', end: '2026-10-15T10:00:00+02:00', allDay: false, link: null},
				],
			}),
		);
		getWriteTarget.mockResolvedValue(Ok({connectionId: 'work', parent: 'me@work'}));
		const {handleAgendaRoute} = await import('./agenda');

		const agenda = (await handleAgendaRoute({user: {userId: 'user-1'}, query: {from, to}} as never)).unwrap();
		expect(googleCalendars.agenda).toHaveBeenCalledTimes(1);
		expect(agenda.sources.map((source) => source.connectionId)).toEqual(['work']);
		expect(agenda.events.map((event) => event.title)).toEqual(['Sooner', 'Later']);
		expect(agenda.target).toEqual({connectionId: 'work', calendarId: 'me@work'});
		expect(getWriteTarget).toHaveBeenCalledWith('user-1', 'events');
	});

	test('refuses a range past two days, or backwards', async () => {
		const {handleAgendaRoute} = await import('./agenda');
		for (const query of [
			{from, to: '2026-10-20T00:00:00.000+02:00'},
			{from: to, to: from},
		]) {
			expect((await handleAgendaRoute({user: {userId: 'user-1'}, query} as never)).unwrapErr().kind).toBe('validation_error');
		}
		expect(findSources).not.toHaveBeenCalled();
	});
});

describe('handleFindEventsRoute', () => {
	const from = '2026-10-16T00:00:00.000+02:00';
	const event = (connectionId: string, id: string, start: string) => ({connectionId, calendarId: 'me', id, title: id, start, end: start, allDay: false, link: null});

	test('searches every calendar with each search, soonest first across them', async () => {
		findSources.mockResolvedValue(
			Ok([
				{connection: {id: 'work'}, integration: {id: 'google'}},
				{connection: {id: 'home'}, integration: {id: 'google'}},
			]),
		);
		googleCalendars.search.mockImplementation(async (source: {connection: {id: string}}) =>
			Ok(source.connection.id === 'work' ? [event('work', 'later', '2026-10-21T15:00:00+02:00')] : [event('home', 'sooner', '2026-10-17T09:00:00+02:00')]),
		);
		const {handleFindEventsRoute} = await import('./agenda');

		const found = (await handleFindEventsRoute({user: {userId: 'user-1'}, query: {from, search: ['arne', ' arne@example.com ', 'arne']}} as never)).unwrap();
		expect(findSources).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'events', 'list');
		expect(googleCalendars.search).toHaveBeenCalledWith(expect.anything(), {from, searches: ['arne', 'arne@example.com']});
		expect(found.events.map((one) => one.id)).toEqual(['sooner', 'later']);
	});

	test('takes one search to three, and a time to search from', async () => {
		const {handleFindEventsRoute} = await import('./agenda');
		for (const query of [{from}, {from, search: ['a', 'b', 'c', 'd']}, {search: 'arne'}]) {
			expect((await handleFindEventsRoute({user: {userId: 'user-1'}, query} as never)).unwrapErr().kind).toBe('parse_error');
		}
		expect(findSources).not.toHaveBeenCalled();
	});
});
