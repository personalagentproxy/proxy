import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {SlackSessionPlace, SlackSessionState, SlackSessionStatus} from '@proxy/db/slack-sessions';

const log = {debug: mock(), info: mock(), warn: mock(), error: mock()};
mock.module('../observability/log', () => ({log, serializeError: mock(() => ({}))}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const {keepSession, promptSession} = await import('./sessions');
type SessionStore = import('./sessions').SessionStore;

// Slack's Web API: every request it was sent, and what it answers each in turn; once those run
// out, it takes every status.
const slack = {sent: [] as URLSearchParams[], methods: [] as string[], answers: [] as Array<() => Response>};
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	slack.methods.push(url.split('/').at(-1) ?? '');
	slack.sent.push(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
	return (slack.answers.shift() ?? (() => Response.json({ok: true, status: 'processing'})))();
}) as typeof fetch);

afterEach(() => {
	fetchSpy.mockClear();
	for (const level of Object.values(log)) {
		level.mockClear();
	}
	slack.sent = [];
	slack.methods = [];
	slack.answers = [];
});

const refusal = (error: string) => () => Response.json({ok: false, error});

// A thread's place in Slack, as the database would keep it, its thread opened from Slack a moment ago; with what was done to it.
function world(fields: Partial<SlackSessionPlace> | null = {}, standing: Partial<SlackSessionState> = {}) {
	const place: SlackSessionPlace = {
		id: 'place-1',
		threadId: 'thread-1',
		channel: 'D01',
		rootTs: '1700000000.000100',
		session: {status: null, title: null, setAt: null, attempts: 0, retryAt: null},
		app: {id: 'app-1', botToken: 'enc:xoxb-bot', removedAt: null, sessionsOffUntil: null},
		...fields,
	};
	const thread: SlackSessionState = {state: {kind: 'working'}, waitingForMember: false, alerts: 0, subAgentsAtWork: false, title: 'Compare the fares to Lyon', lastSeq: 1, ...standing};
	const done = {statuses: [] as SlackSessionStatus[], titles: [] as Array<string | null>, removed: false};
	const store: SessionStore = {
		place: async () => Ok(fields === null ? null : place),
		state: async () => Ok(thread),
		noteSet: async (_id, status, at, made) => {
			done.statuses.push(status);
			place.session = {status, title: made === null ? place.session.title : made.title, setAt: at, attempts: 0, retryAt: null};
			return Ok(undefined);
		},
		noteRenamed: async (_id, title) => {
			done.titles.push(title);
			place.session = {...place.session, title, attempts: 0, retryAt: null};
			return Ok(undefined);
		},
		noteFailed: async (_id, attempts, retryAt) => {
			place.session = {...place.session, attempts, retryAt};
			return Ok(undefined);
		},
		turnOff: async (_id, until) => {
			place.app.sessionsOffUntil = until;
			return Ok(undefined);
		},
		markAppRemoved: async () => {
			done.removed = true;
			return Ok(undefined);
		},
	};
	return {place, thread, store, done};
}

describe('the session as a message from Slack is taken up', () => {
	test('is set processing straight away, made with the thread’s title', async () => {
		const {place, store, done} = world();

		await promptSession(store, 'enc:xoxb-bot', 'thread-1');

		expect(slack.sent.map((body) => Object.fromEntries(body))).toEqual([{channel_id: 'D01', thread_ts: '1700000000.000100', status: 'processing', title: 'Compare the fares to Lyon'}]);
		expect(done.statuses).toEqual(['processing']);
		expect(place.session.title).toBe('Compare the fares to Lyon');
	});

	test('is set without the title where a status was set before', async () => {
		const {store} = world({session: {status: 'suspended', title: 'Compare the fares to Lyon', setAt: new Date(), attempts: 0, retryAt: null}});

		await promptSession(store, 'enc:xoxb-bot', 'thread-1');

		expect(slack.sent.map((body) => body.get('status'))).toEqual(['processing']);
		expect(slack.sent[0]?.has('title')).toBe(false);
	});

	test('is left where the place is stopped or its app removed, which has none to read', async () => {
		const {store} = world(null);
		await promptSession(store, 'enc:xoxb-bot', 'thread-1');
		expect(slack.sent).toEqual([]);
	});

	test('is left where it is processing already', async () => {
		const {store} = world({session: {status: 'processing', title: 'Compare the fares to Lyon', setAt: new Date(), attempts: 0, retryAt: null}});
		await promptSession(store, 'enc:xoxb-bot', 'thread-1');
		expect(slack.sent).toEqual([]);
	});
});

describe('the session kept true by the sweep', () => {
	const now = new Date('2026-11-16T12:00:00Z');
	const made = (status: SlackSessionStatus) => ({session: {status, title: 'Compare the fares to Lyon', setAt: now, attempts: 0, retryAt: null}});

	const table: Array<[string, Partial<SlackSessionState>, SlackSessionStatus]> = [
		['asleep until it wakes, which is at work', {state: {kind: 'asleep', until: new Date('2026-11-17T09:00:00Z')}}, 'processing'],
		['stopped, waiting for the member', {state: {kind: 'stopped'}, waitingForMember: true}, 'suspended'],
		['stopped, done', {state: {kind: 'stopped'}}, 'active'],
		['stopped, watching for alerts, as done is', {state: {kind: 'stopped'}, alerts: 2}, 'active'],
		['stopped, while a sub-agent still works', {state: {kind: 'stopped'}, subAgentsAtWork: true}, 'processing'],
		['stopped and waiting, while a sub-agent still works', {state: {kind: 'stopped'}, waitingForMember: true, subAgentsAtWork: true}, 'processing'],
	];
	for (const [name, standing, status] of table) {
		test(`${name}: ${status}`, async () => {
			const {place, store} = world(made(status === 'processing' ? 'active' : 'processing'), standing);

			await keepSession(store, 'xoxb-bot', place, 1, now);

			expect(slack.sent.map((body) => body.get('status'))).toEqual([status]);
		});
	}

	test('nothing while the thread said more than is posted, which goes first', async () => {
		const {place, store} = world(made('processing'), {state: {kind: 'stopped'}, lastSeq: 5});

		await keepSession(store, 'xoxb-bot', place, 4, now);

		expect(slack.sent).toEqual([]);
	});

	test('renamed once to the title a small model wrote after the session was made with the line of the first message, and not again', async () => {
		const {place, store, done} = world({session: {status: 'processing', title: 'can you compare the fares to lyon for friday', setAt: now, attempts: 0, retryAt: null}});

		await keepSession(store, 'xoxb-bot', place, 1, now);
		await keepSession(store, 'xoxb-bot', place, 1, now);

		expect(slack.methods).toEqual(['agents.sessions.rename']);
		expect(Object.fromEntries(slack.sent[0] ?? [])).toEqual({channel_id: 'D01', thread_ts: '1700000000.000100', title: 'Compare the fares to Lyon'});
		expect(done.titles).toEqual(['Compare the fares to Lyon']);
	});

	test('its status set first where both are due, then renamed', async () => {
		const {place, store} = world({session: {status: 'processing', title: 'can you compare the fares to lyon', setAt: now, attempts: 0, retryAt: null}}, {state: {kind: 'stopped'}});

		await keepSession(store, 'xoxb-bot', place, 1, now);

		expect(slack.methods).toEqual(['agents.sessions.setStatus', 'agents.sessions.rename']);
		expect(slack.sent[0]?.has('title')).toBe(false);
	});

	test('made with the title it has where none was set, and not renamed after', async () => {
		const {place, store} = world({}, {state: {kind: 'stopped'}});

		await keepSession(store, 'xoxb-bot', place, 1, now);
		await keepSession(store, 'xoxb-bot', place, 1, now);

		expect(slack.methods).toEqual(['agents.sessions.setStatus']);
		expect(slack.sent[0]?.get('title')).toBe('Compare the fares to Lyon');
	});

	test('a session Slack has none of to rename keeps its title, and isn’t asked again', async () => {
		const {place, store, done} = world({session: {status: 'active', title: 'compare fares', setAt: now, attempts: 0, retryAt: null}}, {state: {kind: 'stopped'}});
		slack.answers = [refusal('session_not_found')];

		await keepSession(store, 'xoxb-bot', place, 1, now);
		await keepSession(store, 'xoxb-bot', place, 1, now);

		expect(slack.methods).toEqual(['agents.sessions.rename']);
		expect(done.titles).toEqual(['Compare the fares to Lyon']);
	});
});

describe('Slack’s agent features not there', () => {
	test('turn the app’s sessions off for a day, with no more calls and no error logged', async () => {
		const {place, store, done} = world();
		slack.answers = [refusal('feature_disabled')];
		const now = new Date('2026-11-16T12:00:00Z');

		await promptSession(store, 'enc:xoxb-bot', 'thread-1', now);

		expect(place.app.sessionsOffUntil).toEqual(new Date('2026-11-17T12:00:00Z'));
		expect(done.statuses).toEqual([]);
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();

		await promptSession(store, 'enc:xoxb-bot', 'thread-1', new Date('2026-11-17T11:59:00Z'));
		await keepSession(store, 'xoxb-bot', place, 1, new Date('2026-11-17T11:59:00Z'));
		expect(slack.sent).toHaveLength(1);

		await promptSession(store, 'enc:xoxb-bot', 'thread-1', new Date('2026-11-17T12:00:01Z'));
		expect(slack.sent).toHaveLength(2);
		expect(done.statuses).toEqual(['processing']);
	});
});

describe('Slack answering with a warning', () => {
	test('is an answer, not logged as an error', async () => {
		const {store, done} = world();
		slack.answers = [
			() =>
				Response.json({
					ok: true,
					status: 'processing',
					warning: 'missing_agent_session_stopped_event_subscription',
					response_metadata: {warnings: ['missing_agent_session_stopped_event_subscription']},
				}),
		];

		await promptSession(store, 'enc:xoxb-bot', 'thread-1');

		expect(done.statuses).toEqual(['processing']);
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});
});

describe('any other failure', () => {
	test('is logged once and tried again later, waiting longer each time', async () => {
		const {place, store} = world();
		const now = new Date('2026-11-16T12:00:00Z');
		slack.answers = [refusal('internal_error'), refusal('internal_error')];

		await promptSession(store, 'enc:xoxb-bot', 'thread-1', now);
		expect(place.session).toMatchObject({status: null, attempts: 1, retryAt: new Date('2026-11-16T12:00:05Z')});

		// Not before it is time.
		await keepSession(store, 'xoxb-bot', place, 1, new Date('2026-11-16T12:00:04Z'));
		expect(slack.sent).toHaveLength(1);

		await keepSession(store, 'xoxb-bot', place, 1, new Date('2026-11-16T12:00:05Z'));
		expect(slack.sent).toHaveLength(2);
		expect(place.session).toMatchObject({attempts: 2, retryAt: new Date('2026-11-16T12:00:15Z')});
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.error).not.toHaveBeenCalled();
	});

	test('waits as long as Slack says on a rate limit', async () => {
		const {place, store} = world();
		const now = new Date('2026-11-16T12:00:00Z');
		slack.answers = [() => new Response('', {status: 429, headers: {'retry-after': '20'}})];

		await promptSession(store, 'enc:xoxb-bot', 'thread-1', now);

		expect(place.session).toMatchObject({attempts: 0, retryAt: new Date('2026-11-16T12:00:20Z')});
		expect(log.warn).not.toHaveBeenCalled();
	});

	test('marks the app removed where Slack no longer takes its token', async () => {
		const {store, done} = world();
		slack.answers = [refusal('token_revoked')];

		await promptSession(store, 'enc:xoxb-bot', 'thread-1');

		expect(done.removed).toBe(true);
	});
});
