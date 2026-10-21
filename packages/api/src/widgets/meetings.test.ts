import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {GranolaMeeting} from '../connections/granola/granola-mcp';

const listGranolaMeetings = mock();

mock.module('../records/granola-connector', () => ({listGranolaMeetings}));
mock.module('./sources', () => ({
	findSources: async () =>
		Ok([
			{connection: {id: 'granola-1'}, integration: {id: 'granola'}},
			// The vault has no meetings to list.
			{connection: {id: 'vault-1'}, integration: {id: 'vault'}},
		]),
	summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id}),
}));
mock.module('../utils/user-org', () => ({requireUserOrgId: async () => Ok('org-1')}));

function meeting(id: string, title: string, day: string, participants: string, summary = ''): GranolaMeeting {
	return {id, title, date: '', day, url: `https://notes.granola.ai/d/${id}`, participants, summary, privateNotes: ''};
}

const SAM = 'Me (note creator), Sam Lee <sam@example.com>';

const MEETINGS = [
	meeting('m4', 'Standup', '2026-10-14', 'Me (note creator), Jo <jo@example.com>'),
	meeting('m3', 'Sam / me', '2026-10-13', SAM, 'We talked about hiring.'),
	meeting('m2', 'Q4 planning', '2026-10-12', SAM, 'Pricing for Q4, and the pricing page.'),
	meeting('m1', 'Offsite', '2026-10-09', SAM),
];

function request(query: Record<string, string | string[]>) {
	return {user: {userId: 'user-1', experiments: ['ask']}, query} as never;
}

beforeEach(() => {
	listGranolaMeetings.mockReset();
	listGranolaMeetings.mockResolvedValue(Ok(MEETINGS));
});

describe('isParticipant', () => {
	test('a person by name or address, each word beginning one of the participants', async () => {
		const {isParticipant} = await import('./meetings');
		expect(isParticipant(SAM, 'sam')).toBe(true);
		expect(isParticipant(SAM, 'Sam Lee')).toBe(true);
		expect(isParticipant(SAM, 'sam@example.com')).toBe(true);
		expect(isParticipant(SAM, 'samantha')).toBe(false);
		expect(isParticipant(SAM, 'jo')).toBe(false);
	});
});

describe('handleFindMeetingsRoute', () => {
	test('the meetings with every person named, those about the words first, then the newest', async () => {
		const {handleFindMeetingsRoute} = await import('./meetings');
		const found = (await handleFindMeetingsRoute(request({from: '2026-10-01', to: '2026-10-14', with: 'sam', words: 'pricing'}))).unwrap();
		expect(found.meetings.map((one) => one.id)).toEqual(['m2', 'm3', 'm1']);
		expect(found.sources.map((source) => source.connectionId)).toEqual(['granola-1']);
		expect(found.meetings[0]).toEqual({connectionId: 'granola-1', id: 'm2', title: 'Q4 planning', date: '', participants: SAM, link: 'https://notes.granola.ai/d/m2'});
	});

	test('asks Granola to the day after the last, and leaves out what is outside the days', async () => {
		const {handleFindMeetingsRoute} = await import('./meetings');
		const found = (await handleFindMeetingsRoute(request({from: '2026-10-13', to: '2026-10-13'}))).unwrap();
		expect(listGranolaMeetings.mock.calls[0]?.slice(1)).toEqual(['2026-10-13', '2026-10-14']);
		expect(found.meetings.map((one) => one.id)).toEqual(['m3']);
	});

	test('the last month when no days are said', async () => {
		const {handleFindMeetingsRoute} = await import('./meetings');
		(await handleFindMeetingsRoute(request({}))).unwrap();
		const [, from, to] = listGranolaMeetings.mock.calls[0] ?? [];
		expect(Date.parse(to) - Date.parse(from)).toBe(31 * 24 * 60 * 60 * 1000);
	});
});
