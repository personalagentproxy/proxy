import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {Meeting} from '../records/capabilities';

const between = mock();
const withNotes = mock();

mock.module('./sources', () => ({
	findSources: async () =>
		Ok([
			{connection: {id: 'granola-1'}, connector: {meetings: {between, withNotes}}},
			// The vault has no meetings to list.
			{connection: {id: 'vault-1'}, connector: {}},
		]),
	summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id}),
	withCapability: (sources: Array<{connector: object}>, capability: string) => sources.filter((source) => capability in source.connector),
}));
mock.module('../utils/user-org', () => ({
	requireViewer: async (request: {user: {experiments?: string[]}}) =>
		Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: request.user.experiments ?? []}),
}));

function meeting(id: string, title: string, participants: string, notes = ''): Meeting {
	return {id, title, date: '', link: `https://notes.granola.ai/d/${id}`, participants, notes};
}

const SAM = 'Me (note creator), Sam Lee <sam@example.com>';

const MEETINGS = [
	meeting('m4', 'Standup', 'Me (note creator), Jo <jo@example.com>'),
	meeting('m3', 'Sam / me', SAM, 'We talked about hiring.'),
	meeting('m2', 'Q4 planning', SAM, 'Pricing for Q4, and the pricing page.'),
	meeting('m1', 'Offsite', SAM),
];

function request(query: Record<string, string | string[]>) {
	return {user: {userId: 'user-1', experiments: ['ask']}, query} as never;
}

beforeEach(() => {
	between.mockReset();
	between.mockResolvedValue(Ok(MEETINGS));
	withNotes.mockReset();
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

	test('a person Granola knew of no one but the owner with, by the title naming them, before one only in the notes', async () => {
		between.mockResolvedValue(
			Ok([
				meeting('m6', 'Weekly sync', 'Me (note creator)', 'Dana asked about the launch.'),
				meeting('m5', 'Pricing review with Dana', 'Me (note creator)'),
				meeting('m4', 'Standup', 'Me (note creator), Jo <jo@example.com>'),
			]),
		);
		const {handleFindMeetingsRoute} = await import('./meetings');
		const found = (await handleFindMeetingsRoute(request({with: 'dana'}))).unwrap();
		expect(found.meetings.map((one) => one.id)).toEqual(['m5', 'm6']);
		expect(withNotes).not.toHaveBeenCalled();
	});

	test('reads the newest meetings’ notes when no title or participant has what was searched for', async () => {
		between.mockResolvedValue(Ok([meeting('m6', 'Weekly sync', 'Me (note creator)'), meeting('m5', '1:1', 'Me (note creator)')]));
		withNotes.mockResolvedValue(Ok([meeting('m6', 'Weekly sync', 'Me (note creator)', 'Shipping dates.'), meeting('m5', '1:1', 'Me (note creator)', 'Dana wants to try annual billing.')]));
		const {handleFindMeetingsRoute} = await import('./meetings');
		const found = (await handleFindMeetingsRoute(request({with: 'dana'}))).unwrap();
		expect(withNotes.mock.calls[0]?.[1]).toEqual(['m6', 'm5']);
		expect(found.meetings.map((one) => one.id)).toEqual(['m5']);

		withNotes.mockClear();
		const none = (await handleFindMeetingsRoute(request({words: 'budget'}))).unwrap();
		expect(withNotes).toHaveBeenCalledTimes(1);
		expect(none.meetings).toEqual([]);
	});

	test('leaves out the meetings with none of the words once one has them', async () => {
		const {handleFindMeetingsRoute} = await import('./meetings');
		const found = (await handleFindMeetingsRoute(request({words: ['hiring']}))).unwrap();
		expect(found.meetings.map((one) => one.id)).toEqual(['m3']);
		expect(withNotes).not.toHaveBeenCalled();
	});

	test('asks each notetaker for the days said', async () => {
		const {handleFindMeetingsRoute} = await import('./meetings');
		(await handleFindMeetingsRoute(request({from: '2026-10-13', to: '2026-10-13'}))).unwrap();
		expect(between.mock.calls[0]?.slice(1)).toEqual(['2026-10-13', '2026-10-13']);
	});

	test('the last three months, to tomorrow, when no days are said', async () => {
		const {handleFindMeetingsRoute} = await import('./meetings');
		(await handleFindMeetingsRoute(request({}))).unwrap();
		const [, from, to] = between.mock.calls[0] ?? [];
		expect(Date.parse(to) - Date.parse(from)).toBe(90 * 24 * 60 * 60 * 1000);
	});
});
