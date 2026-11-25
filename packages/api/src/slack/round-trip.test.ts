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
// same thread; the app neither shows the thread nor takes a reply in it, since it lives in Slack
// alone; and archived through the member's Chat connection its session goes `active`, until a
// reply in Slack brings it back, as one in the app does. A message a Chat thread's agent passes on
// to a Slack thread through the Chat connection is posted there, quoted under a lead, and wakes it;
// one passed on from the Slack thread lands in the Chat thread, saying where from, and goes to
// Slack not at all. A Chat thread opens one in Slack with another persona, whose app posts the
// member's words at the top of their DM with it, once, and replies under it continue it; a Slack
// thread opens one in the app. An alert set in a Slack thread that opens new threads opens each in
// Slack, its line posted at the top of the DM once its agent's turn is over, and nothing at all
// where its agent dismisses it; once the member is no longer linked to Slack, the thread it opens
// lives in the app. Run with the database up (`bun run --cwd packages/db db:dev`) and the environment
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

// Slack's Web API: what it was asked, each a method and its arguments; every call it takes, a DM
// opened being `slack.dm`.
const slack = {asked: [] as Array<{method: string; body: URLSearchParams}>, ts: 0, dm: ''};
spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const method = url.split('/').at(-1) ?? '';
	slack.asked.push({method, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '')});
	if (method === 'conversations.open') {
		return Response.json({ok: true, channel: {id: slack.dm}});
	}
	slack.ts += 1;
	return Response.json({ok: true, ts: `1800000000.${String(slack.ts).padStart(6, '0')}`});
}) as typeof fetch);

// What Slack was asked since the last look, in order: each message's words, each status as
// `status:`, the title a session was made with as `made:`, each it was renamed to as `title:`, a
// DM opened as `open:` with whom.
function asked(): string[] {
	const seen = slack.asked.flatMap(({method, body}) => {
		if (method === 'conversations.open') {
			return [`open:${body.get('users') ?? ''}`];
		}
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

	// A message event Slack sends the app's address, signed with its secret, as the route reads it;
	// to another app, in its DM, where `to` says.
	async function send(
		event: {text: string; ts: string; thread_ts?: string; bot_id?: string; user?: string},
		to: {appId: string; channel: string; slackAppId: string} = {appId, channel, slackAppId: `A-${stamp}`},
	) {
		const {handleSlackEventsRoute} = await import('./events');
		const body = JSON.stringify({
			type: 'event_callback',
			api_app_id: to.slackAppId,
			team_id: `T-${stamp}`,
			event_id: `Ev-${to.appId}-${event.ts}`,
			event: {type: 'message', channel: to.channel, channel_type: 'im', user: 'U01', ...event},
		});
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
		const request = Object.assign(Readable.from([Buffer.from(body)]), {headers: {'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature}, params: {id: to.appId}});
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

	// The member's Chat connection's threads, as a call made for `taskId` reaches them, or as one
	// made for no task, as a sweep's.
	async function threads(taskId?: string) {
		const {findCollection, findIntegration} = await import('@proxy/integrations');
		const chat = findIntegration('chat');
		const collection = chat && findCollection(chat, 'threads');
		if (!collection) {
			throw new Error('No threads collection');
		}
		const connection = {
			id: 'chat-1',
			integrationId: 'chat',
			orgId,
			ownerUserId: owner,
			sharedWithEveryone: false,
			shares: [],
			account: 'Slack round trip test',
			createdAt: new Date(),
			tools: null,
			name: null,
			defaults: [],
			credentialRejectedAt: null,
			credential: null,
		};
		return {connection, collection, ...(taskId === undefined ? {} : {by: {agentId, taskId}})};
	}

	// One sweep for this test's places alone.
	async function sweep() {
		const {deliveryStore, sweepSlackDeliveries} = await import('./delivery');
		const {db} = await import('@proxy/db');
		const ours = new Set((await db.slackThreadPlace.findMany({where: {app: {orgId}}, select: {id: true}})).map(({id}) => id));
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
		await db.slackMessage.deleteMany({where: {app: {orgId}}});
		await db.slackThreadPlace.deleteMany({where: {app: {orgId}}});
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

		// Waiting again, then archived through the member's Chat connection: no longer waiting there,
		// so active, and nothing posted; a reply in Slack brings it back, as one in the app would.
		await db.agentThread.update({where: {id: thread.id}, data: {waitingForMember: true}});
		await sweep();
		expect(asked()).toEqual(['status:suspended']);
		const {threadsConnector} = await import('../native/chat/connector');
		const archived = unwrap(await threadsConnector.commands.archive(await threads(), thread.id));
		expect(archived?.values).toMatchObject({standing: 'Archived', place: 'Slack'});
		await sweep();
		expect(asked()).toEqual(['status:active']);
		await send({text: 'Actually, make it Saturday', ts: '1800000000.000700', thread_ts: '1800000000.000100'});
		expect(await db.agentThread.findUniqueOrThrow({where: {id: thread.id}, select: {archived: true}})).toEqual({archived: false});
		expect(asked()).toEqual(['status:processing']);
		await answer(thread.id, 'Moved to Saturday.');
		await sweep();
		expect(asked()).toEqual(['Moved to Saturday.', 'status:active']);
	});

	test('a message passed on from a Chat thread is posted in the Slack thread as the member’s, quoted, and wakes it; one passed on from the Slack thread lands in the Chat thread with where it came from', async () => {
		const {db} = await import('@proxy/db');
		const {getChatThread, openThread} = await import('@proxy/db/harness');
		const {readyForInference} = await import('@proxy/utils/harness');
		const {threadsConnector} = await import('../native/chat/connector');

		// A thread in Slack, answered.
		await send({text: 'Find a hotel in Porto', ts: '1800000000.100100'});
		const inSlack = await db.agentThread.findFirstOrThrow({where: {orgId, userId: owner, title: 'Find a hotel in Porto'}, select: {id: true, parentThreadId: true}});
		await answer(inSlack.id, 'Two by the river, both free in May.');
		await sweep();
		asked();

		// A thread in Chat, with the same persona, answered.
		const chatId = inSlack.parentThreadId ?? '';
		const title = 'Plan the team offsite';
		const opening = {title, task: {orgId, agentId, ownerUserId: owner, personaId, parentId: null, title, goal: title, via: 'harness' as const}};
		const inChat = unwrap(await openThread(chatId, title, opening, readyForInference))?.thread;
		if (!inChat?.taskId) {
			throw new Error('No thread in Chat');
		}
		await answer(inChat.id, 'Porto in May, for twelve?');

		// From the Chat thread to the Slack thread: posted there as the member's, quoted, and it wakes.
		const sent = unwrap(await threadsConnector.commands.send(await threads(inChat.taskId), inSlack.id, {text: 'Yes, twelve people, two nights'}));
		expect(sent?.values).toMatchObject({place: 'Slack', standing: 'In progress'});
		await sweep();
		const quote = slack.asked.find(({method}) => method === 'chat.postMessage');
		expect(Object.fromEntries(quote?.body ?? [])).toMatchObject({
			channel,
			thread_ts: '1800000000.100100',
			markdown_text: 'Your message, passed on from “Plan the team offsite”:\n> Yes, twelve people, two nights',
		});
		expect(asked()).toEqual(['Your message, passed on from “Plan the team offsite”:\n> Yes, twelve people, two nights', 'status:processing']);
		await sweep();
		expect(asked()).toEqual([]);
		await answer(inSlack.id, 'Holding six rooms for two nights.');
		await sweep();
		expect(asked()).toEqual(['Holding six rooms for two nights.', 'status:active']);

		// The Slack thread's latest from the member was passed on to it: it passes nothing on, until they write in it.
		const slackTask = async () => (await db.agentThread.findUniqueOrThrow({where: {id: inSlack.id}, select: {taskId: true}})).taskId ?? '';
		expect((await threadsConnector.commands.send(await threads(await slackTask()), inChat.id, {text: 'Rooms are held'})).unwrapErr()).toMatchObject({
			message: expect.stringContaining('until you write in it directly'),
		});
		await send({text: 'Tell the offsite thread the rooms are held', ts: '1800000000.100500', thread_ts: '1800000000.100100'});
		expect(asked()).toEqual(['status:processing']);

		// From the Slack thread to the Chat thread: there as the member's, with where it came from; nothing goes to Slack.
		const back = unwrap(await threadsConnector.commands.send(await threads(await slackTask()), inChat.id, {text: 'The rooms are held, six for two nights'}));
		expect(back?.values).toMatchObject({place: 'Chat', standing: 'In progress'});
		const shown = unwrap(await getChatThread(chatId, inChat.id, []));
		expect(shown?.entries.at(-1)).toMatchObject({
			kind: 'person',
			text: 'The rooms are held, six for two nights',
			passedOn: {threadId: inSlack.id, thread: {id: inSlack.id, title: 'Find a hotel in Porto', slack: {teamId: `T-${stamp}`, channel, rootTs: '1800000000.100100'}}},
		});
		expect(await db.agentJob.count({where: {threadId: inChat.id, kind: 'inference', status: 'queued'}})).toBe(1);
		await sweep();
		expect(asked()).toEqual([]);

		// A call made for no thread's task is refused, and nothing is sent.
		expect((await threadsConnector.commands.send(await threads(), inChat.id, {text: 'Hello'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});

	test('a Chat thread opens one in Slack with another persona, posted at the top of the member’s DM with it, and a reply there continues it; a Slack thread opens one in the app', async () => {
		const {db} = await import('@proxy/db');
		const {createPersona, getChatThread, listChatThreads, openThread} = await import('@proxy/db/harness');
		const {startSlackApp} = await import('@proxy/db/slack');
		const {readyForInference} = await import('@proxy/utils/harness');
		const {threadsConnector} = await import('../native/chat/connector');

		// A second persona in Slack, its app installed, the member never having written to it.
		const legalId = unwrap(await createPersona(orgId, owner, {name: 'Legal', look, color: 'plum'}, true)).id;
		const workspaceId = (await db.slackApp.findUniqueOrThrow({where: {id: appId}})).workspaceId;
		const started = unwrap(await startSlackApp({orgId, personaId: legalId, workspaceId, manifestVersion: 1, manifestName: 'Legal', addedById: owner}));
		if (started.kind !== 'started') {
			throw new Error(started.kind);
		}
		const legal = {appId: started.app.id, channel: `D-legal-${stamp}`, slackAppId: `A-legal-${stamp}`};
		await db.slackApp.update({
			where: {id: legal.appId},
			data: {
				slackAppId: legal.slackAppId,
				clientId: '333.444',
				secrets: `enc:${JSON.stringify({clientSecret: 'client-secret', signingSecret: SECRET})}`,
				botToken: 'enc:xoxb-legal',
				botUserId: 'ULEGAL',
				installedAt: new Date(),
				scopes: ['im:history', 'chat:write', 'assistant:write', 'im:write'],
			},
		});
		slack.dm = legal.channel;

		// A thread in Chat with Travel, answered.
		const travelChat = await db.agentThread.findFirstOrThrow({where: {orgId, personaId, userId: owner, parentThreadId: null}});
		const title = 'Renew the venue contract';
		const opening = {title, task: {orgId, agentId, ownerUserId: owner, personaId, parentId: null, title, goal: title, via: 'harness' as const}};
		const inChat = unwrap(await openThread(travelChat.id, title, opening, readyForInference))?.thread;
		if (!inChat?.taskId) {
			throw new Error('No thread in Chat');
		}
		await answer(inChat.id, 'Legal should check the cancellation terms first.');
		asked();

		// "Start this in Slack with Legal": the DM opened, the member's words posted at its top, naming the place, at once.
		const lead = 'Your message, passed on from “Renew the venue contract”:\n> Check the cancellation terms of the venue contract';
		const opened = unwrap(await threadsConnector.newCommands.open(await threads(inChat.taskId), {text: 'Check the cancellation terms of the venue contract', agent: 'Legal', place: 'Slack'}));
		const [dm, root] = slack.asked;
		expect(Object.fromEntries(dm?.body ?? [])).toEqual({users: 'U01'});
		expect(root?.body.get('channel')).toBe(legal.channel);
		expect(root?.body.has('thread_ts')).toBe(false);
		const place = await db.slackThreadPlace.findFirstOrThrow({where: {appId: legal.appId}});
		expect(JSON.parse(root?.body.get('metadata') ?? '{}')).toEqual({event_type: 'thread_opened', event_payload: {place: place.id}});
		const rootTs = place.rootTs ?? '';
		expect(rootTs).not.toBe('');
		expect(asked()).toEqual(['open:U01', lead, 'status:processing', 'made:Check the cancellation terms of the venue contract']);
		expect(opened).toMatchObject({
			values: {agent: 'Legal', place: 'Slack', standing: 'In progress'},
			url: `https://app.slack.com/client/T-${stamp}/${legal.channel}/thread/${legal.channel}-${rootTs}`,
		});
		await sweep();
		expect(asked()).toEqual([]);

		// Never in the app; its own root message coming back is no message of the member's; its agent's answer goes under the root.
		const legalThread = place.threadId;
		const legalChat = await db.agentThread.findFirstOrThrow({where: {personaId: legalId, userId: owner, parentThreadId: null}});
		expect(unwrap(await listChatThreads(legalChat.id, []))).toEqual([]);
		await send({text: 'Your message, passed on…', ts: rootTs, bot_id: 'BLEGAL', user: 'ULEGAL'}, legal);
		expect(await db.agentThread.count({where: {parentThreadId: legalChat.id}})).toBe(1);
		await answer(legalThread, 'Cancelling costs 20% until March.');
		await sweep();
		expect(slack.asked.find(({method}) => method === 'chat.postMessage')?.body.get('thread_ts')).toBe(rootTs);
		expect(asked()).toEqual(['Cancelling costs 20% until March.', 'status:active']);

		// A reply under the root continues it.
		await send({text: 'And after March?', ts: '1800000001.000100', thread_ts: rootTs}, legal);
		expect(await db.agentThread.count({where: {parentThreadId: legalChat.id}})).toBe(1);
		const said = await db.agentEntry.findMany({where: {threadId: legalThread, kind: 'person'}, orderBy: {seq: 'asc'}, select: {text: true, passedOnFromId: true}});
		expect(said).toEqual([
			{text: 'Check the cancellation terms of the venue contract', passedOnFromId: inChat.id},
			{text: 'And after March?', passedOnFromId: null},
		]);
		expect(asked()).toEqual(['status:processing']);
		await answer(legalThread, 'After March it costs half.');
		await sweep();
		expect(asked()).toEqual(['After March it costs half.', 'status:active']);

		// From that Slack thread, written in directly: "open this in the app", with Travel. Nothing goes to Slack.
		const legalTask = (await db.agentThread.findUniqueOrThrow({where: {id: legalThread}, select: {taskId: true}})).taskId ?? '';
		const back = unwrap(await threadsConnector.newCommands.open(await threads(legalTask), {text: 'Book the venue for May once the terms are clear', agent: 'Travel', place: 'Chat'}));
		expect(back).toMatchObject({values: {agent: 'Travel', place: 'Chat', standing: 'In progress'}});
		const shown = unwrap(await getChatThread(travelChat.id, back?.id ?? '', []));
		expect(shown?.entries[0]).toMatchObject({
			kind: 'person',
			text: 'Book the venue for May once the terms are clear',
			passedOn: {threadId: legalThread, thread: {title: 'Check the cancellation terms of the venue contract', slack: {channel: legal.channel, rootTs}}},
		});
		await sweep();
		expect(asked()).toEqual([]);
	});

	test('an alert set in a Slack thread opens each of its threads in Slack once its agent’s turn is over, leaves nothing for one its agent dismisses, and opens one in the app once Slack can’t take it', async () => {
		const {db} = await import('@proxy/db');
		const {setAlertInline} = await import('@proxy/db/alerts');
		const {completeInference, dismissThreadInline, listChatThreads} = await import('@proxy/db/harness');
		const {readyForInference} = await import('@proxy/utils/harness');
		const {harnessStore} = await import('../harness/store');
		const {fireDue} = await import('../harness/alert-sweep');

		// A Slack thread whose agent sets a weekly alert that opens a new thread each time.
		await send({text: 'Check our prices against Northwind every Monday', ts: '1800000002.000100'});
		const setIn = await db.agentThread.findFirstOrThrow({where: {orgId, userId: owner, title: 'Check our prices against Northwind every Monday'}, select: {id: true, parentThreadId: true}});
		const turn = await claim(setIn.id);
		const at = new Date(Date.now() - 60_000);
		const made = unwrap(
			await setAlertInline(
				{jobId: turn, workerId: 'test-worker', threadId: setIn.id},
				{
					kind: 'time',
					opens: 'new_thread',
					title: 'Weekly pricing check',
					brief: 'Compare our prices with Northwind’s.',
					at,
					every: {rule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', timeZone: 'UTC'},
				},
			),
		);
		expect(made).toMatchObject({slackAppId: appId, slackChannel: channel});
		const said = {text: 'I’ll check every Monday at 9:00.', toolCalls: [], inputTokens: 1, outputTokens: 1, system: null};
		expect(unwrap(await completeInference(turn, 'test-worker', setIn.id, said, {end: {outcome: said.text}}, readyForInference))).toBe(true);
		await sweep();
		asked();
		const alert = await db.agentAlert.findUniqueOrThrow({where: {id: made?.id ?? ''}});
		const opened = async () =>
			await db.agentThread.findMany({
				where: {parentThreadId: setIn.parentThreadId, openedByAlert: true},
				orderBy: {createdAt: 'asc'},
				select: {id: true, slackPlace: {select: {id: true, rootTs: true, channel: true}}},
			});

		// It fires: a thread in Slack, with nothing posted while its agent works.
		expect(unwrap(await fireDue(harnessStore, alert, new Date()))).toBe(true);
		const [first] = await opened();
		expect(first?.slackPlace).toMatchObject({channel, rootTs: null});
		await sweep();
		expect(asked()).toEqual([]);
		// Its turn over: the alert's line at the top of the DM, naming its place, the answer under it,
		// its session last, as the sweep takes it again a moment later.
		await answer(first?.id ?? '', 'Two of our prices are above Northwind’s.');
		await db.slackThreadPlace.update({where: {id: first?.slackPlace?.id ?? ''}, data: {nextAt: new Date()}});
		await sweep();
		const [root, under] = slack.asked;
		expect(root?.body.has('thread_ts')).toBe(false);
		expect(JSON.parse(root?.body.get('metadata') ?? '{}')).toEqual({event_type: 'thread_opened', event_payload: {place: first?.slackPlace?.id}});
		expect(asked()).toEqual(['Alert: “Weekly pricing check” is due', 'Two of our prices are above Northwind’s.', 'status:active', 'made:Weekly pricing check']);
		const rootTs = (await db.slackThreadPlace.findUniqueOrThrow({where: {id: first?.slackPlace?.id ?? ''}})).rootTs;
		expect(under?.body.get('thread_ts')).toBe(rootTs);
		await sweep();
		expect(asked()).toEqual([]);

		// It fires again: its agent dismisses the thread, and nothing of it reaches Slack.
		expect(unwrap(await fireDue(harnessStore, alert, new Date()))).toBe(true);
		const [, second] = await opened();
		const dismissing = await claim(second?.id ?? '');
		expect(unwrap(await dismissThreadInline({jobId: dismissing, workerId: 'test-worker', threadId: second?.id ?? ''}))).toBe(true);
		const nothing = {text: '', toolCalls: [], inputTokens: 1, outputTokens: 1, system: null};
		expect(unwrap(await completeInference(dismissing, 'test-worker', second?.id ?? '', nothing, {end: {outcome: 'Dismissed'}}, readyForInference))).toBe(true);
		await db.slackThreadPlace.update({where: {id: second?.slackPlace?.id ?? ''}, data: {nextAt: new Date()}});
		await sweep();
		await sweep();
		expect(asked()).toEqual([]);
		expect(await db.slackThreadPlace.findUniqueOrThrow({where: {id: second?.slackPlace?.id ?? ''}})).toMatchObject({rootTs: null});

		// The member no longer linked to Slack: the thread it opens lives in the app.
		await db.slackMemberLink.deleteMany({where: {orgId}});
		expect(unwrap(await fireDue(harnessStore, alert, new Date()))).toBe(true);
		const [, , third] = await opened();
		await sweep();
		expect(asked()).toEqual([]);
		expect(await db.slackThreadPlace.count({where: {threadId: third?.id ?? ''}})).toBe(0);
		expect(unwrap(await listChatThreads(setIn.parentThreadId ?? '', [])).map(({id}) => id)).toContain(third?.id ?? 'none');
	});
});
