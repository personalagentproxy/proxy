import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {ShownEntryRow} from '@proxy/db/harness';
import type {SlackDelivery, SlackDeliveryMark, SlackSubAgentRow} from '@proxy/db/slack-delivery';
import type {SlackSessionState, SlackSessionStatus} from '@proxy/db/slack-sessions';

const log = {debug: mock(), info: mock(), warn: mock(), error: mock()};
mock.module('../observability/log', () => ({log, serializeError: mock(() => ({}))}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const {deliverPlace, sweepSlackDeliveries} = await import('./delivery');
type DeliveryStore = import('./delivery').DeliveryStore;

const APP = 'https://proxy.example.com';

// Slack's Web API: every message it was sent, and what it answers each in turn; once those run
// out, it takes every message.
type Sent = {url: string; authorization: string | null; body: URLSearchParams};
const slack = {sent: [] as Sent[], answers: [] as Array<() => Response>};
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	slack.sent.push({url, authorization: new Headers(init?.headers).get('authorization'), body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '')});
	return (slack.answers.shift() ?? (() => Response.json({ok: true, ts: `1700000001.${slack.sent.length}`})))();
}) as typeof fetch);

const refusal = (error: string) => () => Response.json({ok: false, error});

afterEach(() => {
	fetchSpy.mockClear();
	for (const level of Object.values(log)) {
		level.mockClear();
	}
	slack.sent = [];
	slack.answers = [];
});

// What Slack was asked to post, as Markdown, or as plain text with `text:` before it.
function posted(): string[] {
	return slack.sent.filter(({url}) => url.endsWith('/chat.postMessage')).map(({body}) => body.get('markdown_text') ?? `text:${body.get('text') ?? ''}`);
}

// Everything Slack was asked, in order: each message's words, each session status as `status:`,
// each title it was renamed to as `title:`.
function asked(): string[] {
	return slack.sent.map(({url, body}) => {
		if (url.endsWith('/agents.sessions.setStatus')) {
			return `status:${body.get('status') ?? ''}`;
		}
		if (url.endsWith('/agents.sessions.rename')) {
			return `title:${body.get('title') ?? ''}`;
		}
		return body.get('markdown_text') ?? `text:${body.get('text') ?? ''}`;
	});
}

let seq = 0;
function entry(fields: Partial<ShownEntryRow>): ShownEntryRow {
	seq += 1;
	return {id: `entry-${seq}`, seq, kind: 'assistant', pending: false, text: '', toolCalls: null, callId: null, isError: false, passedOn: null, createdAt: new Date('2026-11-16T10:00:00Z'), ...fields};
}

// The thread's place in Slack and its entries, as a database would keep them, with what the sweep
// did to it; and where the thread stands, done unless a test says otherwise, its session set so,
// with the title it has.
function world(entries: ShownEntryRow[], fields: Partial<SlackDelivery> = {}, standing: Partial<SlackSessionState> = {}, subAgents: SlackSubAgentRow[] = []) {
	const place: SlackDelivery = {
		id: 'place-1',
		threadId: 'thread-1',
		channel: 'D01',
		rootTs: '1700000000.000100',
		deliveredSeq: 0,
		partSeq: null,
		partsPosted: 0,
		attempts: 0,
		session: {status: 'active', title: 'Book the train to Lyon', setAt: new Date(), attempts: 0, retryAt: null},
		app: {id: 'app-1', botToken: 'enc:xoxb-bot', removedAt: null, sessionsOffUntil: null},
		thread: {orgId: 'org-1', userId: 'user-1'},
		org: {experiments: ['slack'], insider: false},
		member: {linked: true, inOrganization: true},
		...fields,
	};
	const done = {
		marks: [] as SlackDeliveryMark[],
		released: [] as Array<{delayMs: number; attempts: number}>,
		stopped: null as string | null,
		removed: false,
		statuses: [] as SlackSessionStatus[],
	};
	const thread: SlackSessionState = {
		state: {kind: 'stopped'},
		waitingForMember: false,
		archived: false,
		alerts: 0,
		subAgentsAtWork: false,
		title: 'Book the train to Lyon',
		lastSeq: entries.at(-1)?.seq ?? 0,
		...standing,
	};
	const store: DeliveryStore = {
		claim: async () => Ok([place]),
		read: async (_threadId, afterSeq, limit) => Ok({entries: entries.filter((one) => one.seq > afterSeq).slice(0, limit), subAgents}),
		mark: async (_id, _worker, mark) => {
			done.marks.push({...mark});
			Object.assign(place, mark);
			place.attempts = 0;
			return Ok(true);
		},
		release: async (_id, _worker, delayMs, attempts) => {
			done.released.push({delayMs, attempts});
			place.attempts = attempts;
			return Ok(true);
		},
		stop: async (_id, _worker, why) => {
			done.stopped = why;
			return Ok(true);
		},
		markAppRemoved: async () => {
			done.removed = true;
			return Ok(undefined);
		},
		place: async () => Ok(place),
		state: async () => Ok(thread),
		noteSet: async (_id, status, at, made) => {
			done.statuses.push(status);
			place.session = {status, title: made === null ? place.session.title : made.title, setAt: at, attempts: 0, retryAt: null};
			return Ok(undefined);
		},
		noteRenamed: async (_id, title) => {
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
	};
	const run = () => deliverPlace(store, 'worker-1', APP, place);
	return {place, thread, store, done, run};
}

const sendToPerson = (text: string, id = 'call-1') => ({id, name: 'send_to_person', arguments: JSON.stringify({text})});

describe('delivering a thread to Slack', () => {
	test('posts what the member reads in order, under the root message, once, with no line back to the app', async () => {
		const asked = entry({kind: 'person', text: 'Book the train to Lyon'});
		const answer = entry({text: 'Two trains: **9:40** and 11:10.'});
		const told = entry({toolCalls: [{id: 'call-0', name: 'search_fares', arguments: '{}'}, sendToPerson('Checking seats too.')]});
		const result = entry({kind: 'tool_result', text: '{"seats": 4}'});
		const reply = entry({kind: 'person', text: 'The later one'});
		const {done, run} = world([asked, answer, told, result, reply]);

		await run();

		expect(posted()).toEqual(['Two trains: **9:40** and 11:10.', 'Checking seats too.']);
		const [first] = slack.sent;
		expect(first?.url).toBe('https://slack.com/api/chat.postMessage');
		expect(first?.authorization).toBe('Bearer xoxb-bot');
		expect(Object.fromEntries(first?.body ?? [])).toMatchObject({channel: 'D01', thread_ts: '1700000000.000100', unfurl_links: 'false', unfurl_media: 'false'});
		expect(first?.body.has('text')).toBe(false);
		expect(done.marks).toEqual([
			{deliveredSeq: answer.seq, partSeq: null, partsPosted: 0},
			{deliveredSeq: told.seq, partSeq: null, partsPosted: 0},
			{deliveredSeq: reply.seq, partSeq: null, partsPosted: 0},
		]);
		expect(done.released).toEqual([{delayMs: 0, attempts: 0}]);

		slack.sent = [];
		await run();
		expect(posted()).toEqual([]);
	});

	test('posts what another of the member’s threads passed on, quoted under a lead, in its place among the answers, once, and still not what they wrote in Slack', async () => {
		const asked = entry({kind: 'person', text: 'Upgrade vite to 7'});
		const answer = entry({text: 'Shall I include the docs site?'});
		const passed = entry({kind: 'person', text: 'Yes, include it', passedOn: {threadId: 'thread-9', thread: {id: 'thread-9', personaId: 'persona-1', title: 'Pricing review with Dana', slack: null}}});
		const after = entry({text: 'Including the docs site.'});
		const reply = entry({kind: 'person', text: 'Thanks'});
		const {done, run} = world([asked, answer, passed, after, reply]);

		await run();

		expect(posted()).toEqual(['Shall I include the docs site?', 'Your message, passed on from “Pricing review with Dana”:\n> Yes, include it', 'Including the docs site.']);
		expect(done.marks.map(({deliveredSeq}) => deliveredSeq)).toEqual([answer.seq, passed.seq, after.seq, reply.seq]);

		slack.sent = [];
		await run();
		expect(posted()).toEqual([]);
	});

	test('waits as long as Slack says on a rate limit, then goes on from the message it was limited at', async () => {
		const first = entry({text: 'First.'});
		const second = entry({text: 'Second.'});
		const {done, run} = world([first, second]);
		slack.answers = [() => Response.json({ok: true, ts: '1.1'}), () => new Response('', {status: 429, headers: {'retry-after': '7'}})];

		await run();

		expect(posted()).toEqual(['First.', 'Second.']);
		expect(done.marks.map(({deliveredSeq}) => deliveredSeq)).toEqual([first.seq]);
		expect(done.released).toEqual([{delayMs: 7_000, attempts: 0}]);

		slack.sent = [];
		await run();
		expect(posted()).toEqual(['Second.']);
	});

	test('goes on part way through a long answer from the part it stopped at', async () => {
		const paragraph = 'z'.repeat(8_000);
		const long = entry({text: `${paragraph}\n\n${paragraph}`});
		const {place, done, run} = world([long]);
		slack.answers = [() => Response.json({ok: true, ts: '1.1'}), () => new Response('', {status: 429})];

		await run();

		expect(done.marks).toEqual([{deliveredSeq: 0, partSeq: long.seq, partsPosted: 1}]);
		expect(done.released).toEqual([{delayMs: 30_000, attempts: 0}]);
		slack.sent = [];
		await run();
		expect(posted()).toEqual([paragraph]);
		expect(place).toMatchObject({deliveredSeq: long.seq, partSeq: null, partsPosted: 0});
	});

	test('marks the app removed where Slack no longer takes its token, and posts nothing more', async () => {
		const {done, run} = world([entry({text: 'One.'}), entry({text: 'Two.'})]);
		slack.answers = [refusal('token_revoked')];

		await run();

		expect(posted()).toHaveLength(1);
		expect(done.removed).toBe(true);
		expect(done.marks).toEqual([]);
	});

	test('stops for a Slack thread that is gone, saying why', async () => {
		const {done, run} = world([entry({text: 'One.'}), entry({text: 'Two.'})]);
		slack.answers = [refusal('channel_not_found')];

		await run();

		expect(posted()).toHaveLength(1);
		expect(done.stopped).toBe('channel_not_found');
		expect(done.marks).toEqual([]);
		expect(done.released).toEqual([]);
	});

	test('tries a message Slack won’t take as Markdown once as plain text', async () => {
		const {done, run} = world([entry({text: 'Fares < 100 & rising'})]);
		slack.answers = [refusal('invalid_blocks')];

		await run();

		expect(posted()).toEqual(['Fares < 100 & rising', 'text:Fares &lt; 100 &amp; rising']);
		expect(done.marks.map(({deliveredSeq}) => deliveredSeq)).toHaveLength(2);
	});

	test('skips a message Slack takes neither way, and goes on with the next', async () => {
		const refused = entry({text: 'Odd.'});
		const next = entry({text: 'Next.'});
		const {done, run} = world([refused, next]);
		slack.answers = [refusal('invalid_blocks'), refusal('no_text')];

		await run();

		expect(posted()).toEqual(['Odd.', 'text:Odd.', 'Next.']);
		expect(done.marks.slice(0, 2)).toEqual([
			{deliveredSeq: refused.seq, partSeq: null, partsPosted: 0},
			{deliveredSeq: next.seq, partSeq: null, partsPosted: 0},
		]);
	});

	test('tries again later where Slack fails, waiting longer each time, then skips the message', async () => {
		const failing = entry({text: 'Failing.'});
		const next = entry({text: 'Next.'});
		const {done, run} = world([failing, next]);

		for (let attempt = 1; attempt < 6; attempt += 1) {
			slack.answers = [refusal('internal_error')];
			await run();
		}
		expect(done.released).toEqual([5_000, 10_000, 20_000, 40_000, 80_000].map((delayMs, index) => ({delayMs, attempts: index + 1})));
		expect(done.marks).toEqual([]);

		slack.sent = [];
		slack.answers = [refusal('internal_error')];
		await run();
		expect(posted()).toEqual(['Failing.', 'Next.']);
		expect(done.marks.map(({deliveredSeq}) => deliveredSeq).slice(0, 2)).toEqual([failing.seq, next.seq]);
	});

	test('tries again later where Slack can’t be reached', async () => {
		const {done, run} = world([entry({text: 'One.'})]);
		slack.answers = [
			() => {
				throw new Error('connect ECONNREFUSED');
			},
		];

		await run();

		expect(done.released).toEqual([{delayMs: 5_000, attempts: 1}]);
		expect(done.marks).toEqual([]);
	});

	const asides: Array<[string, Partial<SlackDelivery>]> = [
		['delivers nothing where the organization has Slack off, leaving the mark', {org: {experiments: [], insider: false}}],
		['delivers nothing where the member is no longer linked, leaving the mark', {member: {linked: false, inOrganization: true}}],
		['delivers nothing where the member left the organization, leaving the mark', {member: {linked: true, inOrganization: false}}],
	];
	for (const [name, fields] of asides) {
		test(name, async () => {
			const {done, run} = world([entry({text: 'One.'})], fields);
			await run();
			expect(posted()).toEqual([]);
			expect(done.marks).toEqual([]);
			expect(done.released).toEqual([{delayMs: 60_000, attempts: 0}]);
		});
	}
});

describe('the session, as the sweep keeps it', () => {
	test('is set after the answer that ends a turn is posted, and only where it differs', async () => {
		const answer = entry({text: 'Booked the 9:40.'});
		const {done, run} = world([answer], {session: {status: 'processing', title: 'Book the train to Lyon', setAt: new Date(), attempts: 0, retryAt: null}});

		await run();

		expect(asked()).toEqual(['Booked the 9:40.', 'status:active']);
		expect(done.statuses).toEqual(['active']);
		const status = slack.sent.at(-1);
		expect(status?.authorization).toBe('Bearer xoxb-bot');
		expect(Object.fromEntries(status?.body ?? [])).toEqual({channel_id: 'D01', thread_ts: '1700000000.000100', status: 'active'});

		slack.sent = [];
		await run();
		expect(asked()).toEqual([]);
	});

	test('is suspended for a thread that waits for the member, processing for one at work', async () => {
		const waiting = world([], {}, {waitingForMember: true});
		await waiting.run();
		expect(asked()).toEqual(['status:suspended']);

		slack.sent = [];
		const working = world([], {}, {state: {kind: 'working'}});
		await working.run();
		expect(asked()).toEqual(['status:processing']);
	});

	test('waits while the thread said more than is posted', async () => {
		const answer = entry({text: 'Looking.'});
		const {done, run} = world([answer], {session: {status: 'processing', title: 'Book the train to Lyon', setAt: new Date(), attempts: 0, retryAt: null}}, {lastSeq: answer.seq + 1});

		await run();

		expect(asked()).toEqual(['Looking.']);
		expect(done.statuses).toEqual([]);
	});

	test('is not set before a message Slack hasn’t taken yet', async () => {
		const {done, run} = world([entry({text: 'Done.'})], {session: {status: 'processing', title: 'Book the train to Lyon', setAt: new Date(), attempts: 0, retryAt: null}});
		slack.answers = [() => new Response('', {status: 429})];

		await run();

		expect(asked()).toEqual(['Done.']);
		expect(done.statuses).toEqual([]);
	});

	test('renews processing before Slack’s hour runs out', async () => {
		const fresh = world([], {session: {status: 'processing', title: 'Book the train to Lyon', setAt: new Date(Date.now() - 10 * 60_000), attempts: 0, retryAt: null}}, {state: {kind: 'working'}});
		await fresh.run();
		expect(asked()).toEqual([]);

		const old = world([], {session: {status: 'processing', title: 'Book the train to Lyon', setAt: new Date(Date.now() - 46 * 60_000), attempts: 0, retryAt: null}}, {state: {kind: 'working'}});
		await old.run();
		expect(asked()).toEqual(['status:processing']);
		expect(old.done.statuses).toEqual(['processing']);
	});

	test('carries the thread’s title only where no status was set before', async () => {
		const made = world([], {session: {status: null, title: null, setAt: null, attempts: 0, retryAt: null}});
		await made.run();
		expect(slack.sent[0]?.body.get('title')).toBe('Book the train to Lyon');

		slack.sent = [];
		made.thread.waitingForMember = true;
		await made.run();
		expect(asked()).toEqual(['status:suspended']);
		expect(slack.sent[0]?.body.has('title')).toBe(false);
		expect(slack.sent.some(({url}) => url.endsWith('/agents.sessions.rename'))).toBe(false);
	});

	test('a failure to set it holds up no message, and is logged once', async () => {
		const first = entry({text: 'First.'});
		const {place, done, run} = world([first], {session: {status: 'processing', title: 'Book the train to Lyon', setAt: new Date(), attempts: 0, retryAt: null}});
		slack.answers = [() => Response.json({ok: true, ts: '1.1'}), refusal('internal_error')];

		await run();

		expect(asked()).toEqual(['First.', 'status:active']);
		expect(done.marks.map(({deliveredSeq}) => deliveredSeq).at(-1)).toBe(first.seq);
		expect(done.released).toEqual([{delayMs: 0, attempts: 0}]);
		expect(place.session).toMatchObject({status: 'processing', attempts: 1});
		expect(log.warn).toHaveBeenCalledTimes(1);

		// The next message goes as soon as it is there, the status tried again only once it is time.
		const second = entry({text: 'Second.'});
		const later = world([first, second], {...place, deliveredSeq: first.seq});
		slack.sent = [];
		await later.run();
		expect(asked()).toEqual(['Second.']);

		later.place.session.retryAt = new Date(Date.now() - 1);
		slack.sent = [];
		slack.answers = [refusal('internal_error')];
		await later.run();
		expect(asked()).toEqual(['status:active']);
		expect(later.place.session.attempts).toBe(2);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.error).not.toHaveBeenCalled();
	});
});

describe('a thread at work through a turn', () => {
	const DUE = 'The alert “Renewal” is due now, which you set for 2026-11-20T09:00:00.000Z. What you noted for it: Tell Dana the lease renews.';
	const subAgent: SlackSubAgentRow = {id: 'sub-1', title: 'Fares to Lyon', parentCallId: 'call-sub'};

	test('posts an answer, what it told the member, a failure and an alert, never a sub-agent, its session at work while the sub-agent is', async () => {
		const opened = entry({kind: 'person', text: 'Find a train to Lyon on Friday'});
		const started = entry({
			text: 'Looking into fares and seats.',
			toolCalls: [{id: 'call-sub', name: 'create_subagent', arguments: JSON.stringify({title: 'Fares to Lyon', brief: 'Find the fares'})}, sendToPerson('I have someone checking fares.', 'call-2')],
		});
		const back = entry({kind: 'event', callId: 'call-sub', text: '“Fares to Lyon” (sub-1):\n\nThe 9:40 is cheapest.'});
		const {run} = world(
			[opened, started],
			{session: {status: 'processing', title: 'Train to Lyon on Friday', setAt: new Date(), attempts: 0, retryAt: null}},
			{state: {kind: 'stopped'}, subAgentsAtWork: true, title: 'Train to Lyon on Friday'},
			[subAgent],
		);

		await run();
		// The sub-agent still works once the turn ended: the session stays at work, nothing set.
		expect(asked()).toEqual(['Looking into fares and seats.', 'I have someone checking fares.']);

		// What the sub-agent said back wakes the thread, and is not posted; its failure is.
		const failed = entry({text: 'Something went wrong on my side, so I could not answer: the model is away. Say something to try again.', isError: true});
		const alert = entry({kind: 'event', text: DUE});
		const later = world(
			[opened, started, back, failed, alert],
			{deliveredSeq: started.seq, session: {status: 'processing', title: 'Train to Lyon on Friday', setAt: new Date(), attempts: 0, retryAt: null}},
			{state: {kind: 'stopped'}, title: 'Train to Lyon on Friday'},
			[subAgent],
		);
		slack.sent = [];
		await later.run();
		expect(asked()).toEqual(['Something went wrong on my side, so I could not answer: the model is away. Say something to try again.', 'Alert: “Renewal” is due', 'status:active']);
		expect(later.done.marks.at(-1)?.deliveredSeq).toBe(alert.seq);
	});
});

describe('the sweep', () => {
	test('delivers each place it took', async () => {
		const {store} = world([entry({text: 'Hello.'})]);
		await sweepSlackDeliveries(store, 'worker-1', APP);
		expect(posted()).toEqual(['Hello.']);
	});

	test('posts nothing where it could not take the places', async () => {
		const {store} = world([entry({text: 'Hello.'})]);
		await sweepSlackDeliveries({...store, claim: async () => Err(ApiErr.conflict('The database is away'))}, 'worker-1', APP);
		expect(posted()).toEqual([]);
	});
});
