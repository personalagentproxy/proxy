import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const findSources = mock();
const googleCalendars = mock();
const getWriteTarget = mock(async (): Promise<unknown> => Ok(null));

mock.module('./sources', () => ({findSources, summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id})}));
mock.module('./google-calendars', () => ({googleCalendars}));
mock.module('@proxy/db/write-target', () => ({getWriteTarget}));
mock.module('../utils/user-org', () => ({requireUserOrgId: async () => Ok('org-1')}));

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
		googleCalendars.mockResolvedValue(
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
		expect(googleCalendars).toHaveBeenCalledTimes(1);
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
