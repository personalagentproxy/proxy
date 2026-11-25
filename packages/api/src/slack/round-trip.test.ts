import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';

import {afterAll, beforeAll, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

// The whole way of a message from Slack and back, against the local database, with Slack faked
// and no model: a member's signed message opens a thread in their chat, its session processing at
// once and titled with the message's line; the small model's title renames it; the agent's turn,
// written as the harness writes one, starts a sub-agent and tells the member as it goes, which the
// sweep posts in the Slack thread, the session at work while the sub-agent is and nothing posted of
// the sub-agent; a failure, an alert that fires and an answer follow, each posted once, the session
// going `active`, `processing` and `active` after them; a reply in the Slack thread continues the
// same thread; and the app neither shows the thread nor takes a reply in it, since it lives in
// Slack alone. Run with the database up (`bun run --cwd packages/db db:dev`) and the environment
// loaded, `bun --env-file=../../.env test --isolate src/slack/round-trip.test.ts` from this
// package. Without DATABASE_URL, as `bun run test` runs, it is skipped. Everything made here is
// one organization's, deleted at the end. The sweep is run for this test's place alone: any other
// place in the local database it takes is let go at once.
const databaseUrl = process.env.DATABASE_URL;

const APP_URL = 'https://proxy.example.com';
const SECRET = 'signing-secret';

mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', AUTH_SECRET: 'auth-secret', APP_URL}}));
mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

// Slack's Web API: what it was asked, each a method and its arguments; every call it takes.
const slack = {asked: [] as Array<{method: string; body: URLSearchParams}>, ts: 0};
spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const method = url.split('/').at(-1) ?? '';
	slack.asked.push({method, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '')});
	slack.ts += 1;
	return Response.json({ok: true, ts: `1800000000.${String(slack.ts).padStart(6, '0')}`});
}) as typeof fetch);

// What Slack was asked since the last look, in order: each message's words, each status as
// `status:`, the title a session was made with as `made:`, each it was renamed to as `title:`.
function asked(): string[] {
	const seen = slack.asked.flatMap(({method, body}) => {
		if (method === 'agents.sessions.setStatus') {
			const title = body.get('title');
			return [`status:${body.get('status') ?? ''}`, ...(title === null ? [] : [`made:${title}`])];
		}
		if (method === 'agents.sessions.rename') {
			return [`title:${body.get('title') ?? ''}`];
		}
		return [body.get('markdown_text') ?? body.get('text') ?? ''];
	});
	slack.asked = [];
	return seen;
}

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};

const FAILURE = 'Something went wrong on my side, so I could not answer: the model is away. Say something to try again.';

describe.skipIf(!databaseUrl)('a message from Slack, to a thread and back', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	const channel = `D-${stamp}`;
	let owner = '';
	let orgId = '';
	let agentId = '';
	let personaId = '';
	let appId = '';

	// A message event Slack sends the app's address, signed with its secret, as the route reads it.
	async function send(event: {text: string; ts: string; thread_ts?: string}) {
		const {handleSlackEventsRoute} = await import('./events');
		const body = JSON.stringify({
			type: 'event_callback',
			api_app_id: `A-${stamp}`,
			team_id: `T-${stamp}`,
			event_id: `Ev-${event.ts}`,
			event: {type: 'message', channel, channel_type: 'im', user: 'U01', ...event},
		});
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
		const request = Object.assign(Readable.from([Buffer.from(body)]), {headers: {'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature}, params: {id: appId}});
		const res = {code: 200, status: (code: number) => Object.assign(res, {code}), json: () => {}, end: () => {}};
		await handleSlackEventsRoute(request as never, res as never);
		expect(res.code).toBe(200);
	}

	// The thread's queued turn, claimed as a worker claims it.
	async function claim(threadId: string): Promise<string> {
		const {db} = await import('@proxy/db');
		const turn = await db.agentJob.findFirstOrThrow({where: {threadId, kind: 'inference', status: 'queued'}});
		await db.agentJob.update({where: {id: turn.id}, data: {status: 'running', claimedBy: 'test-worker'}});
		return turn.id;
	}

	// The thread's agent answers and ends its turn, as the harness writes it.
	async function answer(threadId: string, text: string) {
		const {completeInference} = await import('@proxy/db/harness');
		const {readyForInference} = await import('@proxy/utils/harness');
		const jobId = await claim(threadId);
		expect(unwrap(await completeInference(jobId, 'test-worker', threadId, {text, toolCalls: [], inputTokens: 1, outputTokens: 1, system: null}, {end: {outcome: text}}, readyForInference))).toBe(true);
	}

	// One sweep for this test's place alone.
	async function sweep() {
		const {deliveryStore, sweepSlackDeliveries} = await import('./delivery');
		const {db} = await import('@proxy/db');
		const ours = new Set((await db.slackThreadPlace.findMany({where: {appId}, select: {id: true}})).map(({id}) => id));
		const store = {
			...deliveryStore,
			claim: async (...args: Parameters<typeof deliveryStore.claim>) => {
				const claimed = await deliveryStore.claim(...args);
				if (claimed.isErr()) {
					return claimed;
				}
				for (const other of claimed.value.filter(({id}) => !ours.has(id))) {
					await deliveryStore.release(other.id, args[0], 0, other.attempts);
				}
				return Ok(claimed.value.filter(({id}) => ours.has(id)));
			},
		};
		await sweepSlackDeliveries(store, 'test-sweep', APP_URL);
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const {createPersona} = await import('@proxy/db/harness');
		const {linkSlackWorkspace, startSlackApp} = await import('@proxy/db/slack');
		const {linkSlackMember} = await import('@proxy/db/slack-messages');
		const {BUILT_IN_AGENT_PROVIDER} = await import('@proxy/utils/agent-providers');
		owner = (await db.user.create({data: {email: `slack-round-trip-${stamp}@example.test`}})).id;
		orgId = (await db.organization.create({data: {name: 'Slack round trip test', slug: `slack-round-trip-${stamp}`, ownerUserId: owner, experiments: ['slack']}})).id;
		await db.orgMember.create({data: {orgId, userId: owner}});
		// The organization's built-in agent, which it is made with.
		agentId = (await db.agent.create({data: {orgId, providerId: BUILT_IN_AGENT_PROVIDER.id, name: 'Chat', username: `slack-round-trip-${stamp}`, passwordHash: ''}})).id;
		personaId = unwrap(await createPersona(orgId, owner, {name: 'Travel', look, color: 'teal'}, true)).id;
		const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
		const workspaceId = unwrap(
			await linkSlackWorkspace({orgId, teamId: `T-${stamp}`, name: 'Northwind', slackUserId: 'U00', linkedById: owner, credential: 'sealed', expiresAt, rotateAt: expiresAt}),
		).id;
		const started = unwrap(await startSlackApp({orgId, personaId, workspaceId, manifestVersion: 1, manifestName: 'Travel', addedById: owner}));
		if (started.kind !== 'started') {
			throw new Error(started.kind);
		}
		appId = started.app.id;
		await db.slackApp.update({
			where: {id: appId},
			data: {
				slackAppId: `A-${stamp}`,
				clientId: '111.222',
				secrets: `enc:${JSON.stringify({clientSecret: 'client-secret', signingSecret: SECRET})}`,
				botToken: 'enc:xoxb-bot',
				botUserId: 'UBOT',
				installedAt: new Date(),
			},
		});
		unwrap(await linkSlackMember({orgId, workspaceId, slackUserId: 'U01', userId: owner}));
	});

	afterAll(async () => {
		const {db} = await import('@proxy/db');
		await db.slackMessage.deleteMany({where: {appId}});
		await db.slackThreadPlace.deleteMany({where: {appId}});
		await db.slackMemberLink.deleteMany({where: {orgId}});
		await db.slackApp.deleteMany({where: {orgId}});
		await db.slackWorkspace.deleteMany({where: {orgId}});
		await db.organization.deleteMany({where: {id: orgId}});
		await db.user.deleteMany({where: {id: owner}});
	});

	test('opens a thread, posts what the member reads back, keeps its session true, goes on from Slack, and never shows in the app', async () => {
		const {db} = await import('@proxy/db');
		const {completeInference, failJob, getChatThread, listChatThreads, lockThread, replyInThread, wakeWith, writeThreadTitle} = await import('@proxy/db/harness');
		const {readyForInference} = await import('@proxy/utils/harness');

		// A member's message: a thread in their chat with the persona, its session processing at
		// once, made with the thread's title, a line of the message.
		await send({text: 'Find a train to Lyon on Friday', ts: '1800000000.000100'});
		const thread = await db.agentThread.findFirstOrThrow({where: {orgId, personaId, userId: owner, parentThreadId: {not: null}}, select: {id: true, title: true, parentThreadId: true}});
		expect(thread.title).toBe('Find a train to Lyon on Friday');
		const status = slack.asked.find(({method}) => method === 'agents.sessions.setStatus');
		expect(Object.fromEntries(status?.body ?? [])).toEqual({channel_id: channel, thread_ts: '1800000000.000100', status: 'processing', title: 'Find a train to Lyon on Friday'});
		expect(asked()).toEqual(['status:processing', 'made:Find a train to Lyon on Friday']);

		// Nothing to post while the agent works, and the session already says so.
		await sweep();
		expect(asked()).toEqual([]);

		// The small model names the thread as its first turn starts: the session is renamed, once.
		expect(unwrap(await writeThreadTitle(thread.id, 'Train to Lyon on Friday'))).toBe(true);
		await sweep();
		expect(asked()).toEqual(['title:Train to Lyon on Friday']);
		await sweep();
		expect(asked()).toEqual([]);

		// The agent starts a sub-agent and tells the member as it goes: both its words go, no line
		// for the sub-agent.
		const task = {orgId, agentId, ownerUserId: owner, personaId, parentId: null, title: 'Fares to Lyon', goal: 'Find the fares', via: 'harness' as const};
		const started = await claim(thread.id);
		const calls = [
			{id: 'call-sub', name: 'create_subagent', arguments: JSON.stringify({title: 'Fares to Lyon', brief: 'Find the fares'})},
			{id: 'call-tell', name: 'send_to_person', arguments: JSON.stringify({text: 'I asked a helper to compare the fares.'})},
		];
		expect(
			unwrap(
				await completeInference(
					started,
					'test-worker',
					thread.id,
					{text: 'Looking into fares and seats.', toolCalls: calls, inputTokens: 1, outputTokens: 1, system: null},
					{
						plans: {
							'call-sub': {kind: 'create_subagent', start: {callId: 'call-sub', title: 'Fares to Lyon', task, entries: [{kind: 'person', text: 'Find the fares'}]}, started: (id) => `Started ${id}.`},
							'call-tell': {kind: 'answer', text: 'Sent.', isError: false},
						},
					},
					readyForInference,
				),
			),
		).toBe(true);
		await sweep();
		expect(asked()).toEqual(['Looking into fares and seats.', 'I asked a helper to compare the fares.']);

		// Its turn ends while the sub-agent works: posted, and the session stays at work.
		await answer(thread.id, 'I’ll come back once the fares are in.');
		await sweep();
		expect(asked()).toEqual(['I’ll come back once the fares are in.']);
		await sweep();
		expect(asked()).toEqual([]);

		// The sub-agent answers the agent, which wakes it: nothing of it is posted.
		const sub = await db.agentThread.findFirstOrThrow({where: {subAgentOfId: thread.id}, select: {id: true}});
		const subTurn = await claim(sub.id);
		expect(
			unwrap(
				await completeInference(
					subTurn,
					'test-worker',
					sub.id,
					{text: 'The 9:40 is cheapest at 120.', toolCalls: [], inputTokens: 1, outputTokens: 1, system: null},
					{end: {outcome: 'Found the fares', toParent: {stopped: {text: 'The 9:40 is cheapest at 120.', isError: false}, goingOn: {text: 'Still looking.', isError: false}}}},
					readyForInference,
				),
			),
		).toBe(true);
		await sweep();
		expect(asked()).toEqual([]);

		// The agent's turn fails: the failure is posted, then the session is ready for the member.
		const failing = await claim(thread.id);
		expect(unwrap(await failJob(failing, 'test-worker', 'the model is away', () => ({kind: 'end', text: FAILURE, end: {outcome: FAILURE}}), readyForInference))).toBe(true);
		await sweep();
		expect(asked()).toEqual([FAILURE, 'status:active']);

		// An alert fires in the thread: posted as its line, the session at work again.
		await db.$transaction(async (tx) => {
			const locked = await lockThread(tx, thread.id);
			if (locked === null) {
				throw new Error('no thread');
			}
			await wakeWith(
				tx,
				locked,
				{kind: 'event', text: 'The alert “Seat check” is due now, which you set for 2026-11-20T09:00:00.000Z. What you noted for it: See whether a window seat opened up.'},
				readyForInference,
			);
		});
		await sweep();
		expect(asked()).toEqual(['Alert: “Seat check” is due', 'status:processing']);
		await answer(thread.id, 'A window seat opened up on the 9:40.');
		await sweep();
		expect(asked()).toEqual(['A window seat opened up on the 9:40.', 'status:active']);

		// A reply in the Slack thread continues the same thread.
		await send({text: 'Book it', ts: '1800000000.000300', thread_ts: '1800000000.000100'});
		expect(await db.agentThread.count({where: {parentThreadId: thread.parentThreadId, subAgentOfId: null}})).toBe(1);
		const entries = await db.agentEntry.findMany({where: {threadId: thread.id, kind: 'person'}, orderBy: {seq: 'asc'}, select: {text: true}});
		expect(entries.map(({text}) => text)).toEqual(['Find a train to Lyon on Friday', 'Book it']);
		expect(asked()).toEqual(['status:processing']);
		await answer(thread.id, 'Booked, coach 7.');
		await sweep();
		expect(asked()).toEqual(['Booked, coach 7.', 'status:active']);

		// The app neither lists it, finds it by its address, nor takes a reply in it.
		const chatId = thread.parentThreadId ?? '';
		expect(unwrap(await listChatThreads(chatId, []))).toEqual([]);
		expect(unwrap(await getChatThread(chatId, thread.id, []))).toBeNull();
		expect(unwrap(await replyInThread(chatId, thread.id, 'And a seat by the window', readyForInference))).toBeNull();
		await sweep();
		expect(asked()).toEqual([]);

		// Asked in Slack instead, the thread waits for the member: suspended; and once it no longer does: active.
		await send({text: 'And a seat by the window', ts: '1800000000.000500', thread_ts: '1800000000.000100'});
		expect(asked()).toEqual(['status:processing']);
		await answer(thread.id, 'Window seats are gone; an aisle one?');
		await db.agentThread.update({where: {id: thread.id}, data: {waitingForMember: true}});
		await sweep();
		expect(asked()).toEqual(['Window seats are gone; an aisle one?', 'status:suspended']);
		await db.agentThread.update({where: {id: thread.id}, data: {waitingForMember: false}});
		await sweep();
		expect(asked()).toEqual(['status:active']);
	});
});
