import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	appendTurnEntries,
	createPersona,
	ensureMemberChat,
	listPendingMessages,
	type ThreadRow,
} from './harness';
import {linkSlackWorkspace, markSlackAppRemoved, startSlackApp} from './slack';
import {
	claimSlackDeliveries,
	markSlackDelivered,
	readSlackUndelivered,
	releaseSlackDelivery,
	stopSlackDelivery,
} from './slack-delivery';
import {linkSlackMember, takeUpSlackMessage} from './slack-messages';
import {
	getSlackSessionPlace,
	noteSlackSessionFailed,
	noteSlackSessionRenamed,
	noteSlackSessionSet,
	readSlackSessionState,
	turnSlackSessionsOff,
} from './slack-sessions';

// Delivery to Slack, against the local database: run with it up (`bun run --cwd packages/db db:dev`) and the
// environment loaded, `bun --env-file=../../.env test src/slack-delivery.test.ts` from this
// package. Without DATABASE_URL, as `bun run test` runs, it is skipped. Everything made here is one
// organization's, deleted at the end. The local database holds one connection, so two workers
// "at once" take their turns; what they come to is the same.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
const LEASE = 60_000;
const RENEW = 45 * 60_000;

describe.skipIf(!databaseUrl)('delivery to Slack, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let owner = '';
	let orgId = '';
	let agentId = '';
	let personaId = '';
	let appId = '';
	let chat: ThreadRow;
	let ts = 0;

	// A member's message in the DM, at its top or, with `rootTs`, in that Slack thread; its agent
	// isn't woken.
	async function fromSlack(text: string, rootTs: string | null) {
		ts += 1;
		return unwrap(
			await takeUpSlackMessage(
				{
					appId,
					channel: 'D01',
					ts: `${ts}.0`,
					rootTs,
					chatId: chat.id,
					text,
					opening: {
						title: text,
						task: {
							orgId,
							agentId,
							ownerUserId: owner,
							personaId,
							parentId: null,
							title: text,
							goal: text,
							via: 'harness',
						},
					},
				},
				() => false,
			),
		);
	}

	// A thread opened from Slack, with its place; the place's id, the thread's, and the `ts` of
	// the root message the Slack thread hangs under.
	async function placedThread(): Promise<{placeId: string; threadId: string; rootTs: string}> {
		const taken = await fromSlack(`Plan trip ${ts + 1}`, null);
		if (taken.kind !== 'opened') {
			throw new Error(taken.kind);
		}
		// Its session set already to where the thread stands, as its agent isn't woken here: so it
		// is taken for what is past its mark alone, until a test changes that.
		const place = await db.slackThreadPlace.update({
			where: {threadId: taken.threadId},
			data: {sessionStatus: 'active', sessionTitle: `Plan trip ${ts}`, sessionSetAt: new Date()},
		});
		return {placeId: place.id, threadId: taken.threadId, rootTs: place.rootTs ?? ''};
	}

	function answer(
		threadId: string,
		text: string,
		extra: {kind?: 'assistant' | 'tool_result'; callId?: string} = {},
	) {
		return db.agentEntry.create({
			data: {threadId, kind: extra.kind ?? 'assistant', text, callId: extra.callId},
			select: {id: true, seq: true},
		});
	}

	// Takes every place due, as a worker would, and lets go of all but those of `keep`.
	async function claimOnly(workerId: string, keep: string[]) {
		const claimed = unwrap(await claimSlackDeliveries(workerId, LEASE, 100, RENEW));
		for (const place of claimed.filter(({id}) => !keep.includes(id))) {
			unwrap(await releaseSlackDelivery(place.id, workerId, 0, place.attempts));
		}
		return claimed.filter(({id}) => keep.includes(id));
	}

	beforeAll(async () => {
		owner = (await db.user.create({data: {email: `slack-delivery-${stamp}@example.test`}})).id;
		orgId = (
			await db.organization.create({
				data: {
					name: 'Slack delivery test',
					slug: `slack-delivery-${stamp}`,
					ownerUserId: owner,
					experiments: ['slack'],
				},
			})
		).id;
		await db.orgMember.create({data: {orgId, userId: owner}});
		agentId = (
			await db.agent.create({
				data: {
					orgId,
					providerId: 'built-in',
					name: 'Built in',
					username: `slack-delivery-${stamp}`,
					passwordHash: '',
				},
			})
		).id;
		personaId = unwrap(
			await createPersona(orgId, owner, {name: 'Travel', look, color: 'teal'}, true),
		).id;
		const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
		const workspaceId = unwrap(
			await linkSlackWorkspace({
				orgId,
				teamId: `T-${stamp}`,
				name: 'Northwind',
				slackUserId: 'U00',
				linkedById: owner,
				credential: 'sealed',
				expiresAt,
				rotateAt: expiresAt,
			}),
		).id;
		const started = unwrap(
			await startSlackApp({
				orgId,
				personaId,
				workspaceId,
				manifestVersion: 1,
				manifestName: 'Travel',
				addedById: owner,
			}),
		);
		if (started.kind !== 'started') {
			throw new Error(started.kind);
		}
		appId = started.app.id;
		await db.slackApp.update({
			where: {id: appId},
			data: {botToken: 'sealed-bot', installedAt: new Date()},
		});
		unwrap(await linkSlackMember({orgId, workspaceId, slackUserId: 'U01', userId: owner}));
		chat = unwrap(await ensureMemberChat({orgId, agentId, personaId, userId: owner}));
	});

	afterAll(async () => {
		await db.slackMessage.deleteMany({where: {appId}});
		await db.slackThreadPlace.deleteMany({where: {appId}});
		await db.slackMemberLink.deleteMany({where: {orgId}});
		await db.slackApp.deleteMany({where: {orgId}});
		await db.slackWorkspace.deleteMany({where: {orgId}});
		await db.organization.deleteMany({where: {id: orgId}});
		await db.user.deleteMany({where: {id: owner}});
		await db.$disconnect();
	});

	test('takes a place only once there is something past its mark, and one worker of two takes it', async () => {
		const {placeId, threadId} = await placedThread();
		// Its first entry, from Slack, is past the mark: taken, read, and passed over.
		const first = await claimOnly('worker-a', [placeId]);
		expect(first.map(({id}) => id)).toEqual([placeId]);
		const read = unwrap(await readSlackUndelivered(threadId, 0, 50)).entries;
		expect(read.map(({kind}) => kind)).toEqual(['person']);
		unwrap(
			await markSlackDelivered(
				placeId,
				'worker-a',
				{deliveredSeq: read[0]?.seq ?? 0, partSeq: null, partsPosted: 0},
				LEASE,
			),
		);
		unwrap(await releaseSlackDelivery(placeId, 'worker-a', 0, 0));

		// Nothing past it: not taken.
		expect((await claimOnly('worker-a', [placeId])).length).toBe(0);

		await answer(threadId, 'Booked.');
		const [one, two] = await Promise.all([
			claimOnly('worker-a', [placeId]),
			claimOnly('worker-b', [placeId]),
		]);
		expect([one.length, two.length].toSorted()).toEqual([0, 1]);
		const holder = one.length === 1 ? 'worker-a' : 'worker-b';
		expect(one[0] ?? two[0]).toMatchObject({
			member: {linked: true, inOrganization: true},
			org: {experiments: ['slack'], insider: false},
			thread: {orgId, userId: owner},
		});

		// Held: not taken again, and only its holder moves its mark.
		expect((await claimOnly('worker-c', [placeId])).length).toBe(0);
		expect(
			unwrap(
				await markSlackDelivered(
					placeId,
					'worker-c',
					{deliveredSeq: 1, partSeq: null, partsPosted: 0},
					LEASE,
				),
			),
		).toBe(false);
		expect(unwrap(await releaseSlackDelivery(placeId, holder, 0, 0))).toBe(true);
		expect((await claimOnly('worker-c', [placeId])).length).toBe(1);
		unwrap(await releaseSlackDelivery(placeId, 'worker-c', 0, 0));
	});

	test('moves the mark message by message', async () => {
		const {placeId, threadId} = await placedThread();
		const [place] = await claimOnly('worker-a', [placeId]);
		const said = await answer(threadId, 'Long answer.');

		expect(
			unwrap(
				await markSlackDelivered(
					placeId,
					'worker-a',
					{deliveredSeq: place?.deliveredSeq ?? 0, partSeq: said.seq, partsPosted: 1},
					LEASE,
				),
			),
		).toBe(true);
		const partWay = await db.slackThreadPlace.findUniqueOrThrow({where: {id: placeId}});
		expect(partWay).toMatchObject({
			partSeq: said.seq,
			partsPosted: 1,
			attempts: 0,
			claimedBy: 'worker-a',
		});

		unwrap(
			await markSlackDelivered(
				placeId,
				'worker-a',
				{deliveredSeq: said.seq, partSeq: null, partsPosted: 0},
				LEASE,
			),
		);
		unwrap(await releaseSlackDelivery(placeId, 'worker-a', 0, 0));
		const done = await db.slackThreadPlace.findUniqueOrThrow({where: {id: placeId}});
		expect(done).toMatchObject({
			deliveredSeq: said.seq,
			partSeq: null,
			partsPosted: 0,
			claimedBy: null,
		});
		expect((await claimOnly('worker-a', [placeId])).length).toBe(0);
	});

	test('never moves the mark past an earlier entry: one held back while the agent answered comes after it', async () => {
		const {placeId, threadId, rootTs} = await placedThread();
		const turn = await db.agentJob.create({
			data: {threadId, kind: 'inference', status: 'running', claimedBy: 'worker-x'},
		});
		// An alert that comes while the agent answers is held, with a seq drawn now.
		const held = await db.agentEntry.create({
			data: {threadId, kind: 'event', text: 'The alert “Hotel” is due now.', pending: true},
			select: {seq: true},
		});
		const said = await answer(threadId, 'Booked the train.');
		expect(said.seq).toBeGreaterThan(held.seq);

		const before = unwrap(await readSlackUndelivered(threadId, 0, 50)).entries;
		expect(before.map(({kind, text}) => [kind, text])).toEqual([
			['person', ''],
			['assistant', 'Booked the train.'],
		]);
		await claimOnly('worker-a', [placeId]);
		unwrap(
			await markSlackDelivered(
				placeId,
				'worker-a',
				{deliveredSeq: said.seq, partSeq: null, partsPosted: 0},
				LEASE,
			),
		);
		unwrap(await releaseSlackDelivery(placeId, 'worker-a', 0, 0));

		// The turn ends, and a reply in the Slack thread comes: what was held is given a new seq as
		// it takes its place, past the mark.
		await db.agentJob.update({where: {id: turn.id}, data: {status: 'done'}});
		expect((await fromSlack('Thanks', rootTs)).kind).toBe('continued');

		const after = unwrap(await readSlackUndelivered(threadId, said.seq, 50)).entries;
		expect(after.map(({kind, text, pending}) => [kind, text, pending]).toSorted()).toEqual([
			['event', 'The alert “Hotel” is due now.', false],
			['person', '', false],
		]);
		expect((await claimOnly('worker-a', [placeId])).length).toBe(1);
		unwrap(await releaseSlackDelivery(placeId, 'worker-a', 0, 0));
	});

	test('posts each answer of a turn once and in order, the member’s reply in the Slack thread while it runs landing between them', async () => {
		const {placeId, threadId, rootTs} = await placedThread();
		const turn = await db.agentJob.create({
			data: {threadId, kind: 'inference', status: 'running', claimedBy: 'worker-x'},
		});
		const step = (entries: Parameters<typeof appendTurnEntries>[3]) =>
			appendTurnEntries(turn.id, 'worker-x', threadId, entries).then(unwrap);
		const seqOf = async (text: string) =>
			(await db.agentEntry.findFirstOrThrow({where: {threadId, text}, select: {seq: true}})).seq;

		// The turn's first step: an answer made a call.
		const call = {id: 'call-1', name: 'search_fares', arguments: '{}'};
		expect(await step([{kind: 'assistant', text: 'Looking at fares.', toolCalls: [call]}])).toBe(
			true,
		);
		const first = unwrap(await readSlackUndelivered(threadId, 0, 50)).entries;
		expect(first.map(({kind, text}) => [kind, text])).toEqual([
			['person', ''],
			['assistant', 'Looking at fares.'],
		]);
		await claimOnly('worker-a', [placeId]);
		const looked = await seqOf('Looking at fares.');
		unwrap(
			await markSlackDelivered(
				placeId,
				'worker-a',
				{deliveredSeq: looked, partSeq: null, partsPosted: 0},
				LEASE,
			),
		);
		unwrap(await releaseSlackDelivery(placeId, 'worker-a', 0, 0));

		// The member steers from the Slack thread while the call runs: held, not read.
		expect((await fromSlack('Only direct trains', rootTs)).kind).toBe('continued');
		const [steer] = unwrap(await listPendingMessages(threadId));
		expect(unwrap(await readSlackUndelivered(threadId, looked, 50)).entries).toEqual([]);

		// The call's answer, with the reply given to the model beside it, then the next answer.
		expect(
			await step([
				{
					kind: 'tool_result',
					callId: 'call-1',
					text: '{"fares": [120]}',
					isError: false,
					delivered: [steer?.id ?? ''],
				},
				{kind: 'assistant', text: 'Only the 9:40 is direct.', toolCalls: null},
			]),
		).toBe(true);
		const rest = unwrap(await readSlackUndelivered(threadId, looked, 50)).entries;
		expect(rest.map(({kind, text}) => [kind, text])).toEqual([
			['tool_result', ''],
			['person', ''],
			['assistant', 'Only the 9:40 is direct.'],
		]);
		expect(rest.every(({seq}) => seq > looked)).toBe(true);
		expect(rest.map(({seq}) => seq)).toEqual(rest.map(({seq}) => seq).toSorted((a, b) => a - b));

		// Once past the last, nothing is read again.
		const direct = await seqOf('Only the 9:40 is direct.');
		expect((await claimOnly('worker-a', [placeId])).length).toBe(1);
		unwrap(
			await markSlackDelivered(
				placeId,
				'worker-a',
				{deliveredSeq: direct, partSeq: null, partsPosted: 0},
				LEASE,
			),
		);
		unwrap(await releaseSlackDelivery(placeId, 'worker-a', 0, 0));
		expect(unwrap(await readSlackUndelivered(threadId, direct, 50)).entries).toEqual([]);
		await db.agentJob.update({where: {id: turn.id}, data: {status: 'done'}});
	});

	test('reads the thread’s sub-agents with its entries, by the call that started each', async () => {
		const {threadId} = await placedThread();
		await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId,
				userId: owner,
				parentThreadId: chat.id,
				subAgentOfId: threadId,
				parentCallId: 'call-sub',
				title: 'Fares to Lyon',
			},
		});

		expect(unwrap(await readSlackUndelivered(threadId, 0, 50)).subAgents).toEqual([
			{id: expect.any(String), title: 'Fares to Lyon', parentCallId: 'call-sub'},
		]);
	});

	test('reads what is past the mark in order, without the words of what the member said in Slack or of tool traffic', async () => {
		const {threadId} = await placedThread();
		await answer(threadId, 'Two fares.');
		await answer(threadId, '{"fares": [120, 140]}', {kind: 'tool_result', callId: 'call-1'});

		const read = unwrap(await readSlackUndelivered(threadId, 0, 50)).entries;
		expect(read.map(({kind, text}) => [kind, text])).toEqual([
			['person', ''],
			['assistant', 'Two fares.'],
			['tool_result', ''],
		]);
		expect(unwrap(await readSlackUndelivered(threadId, 0, 1)).entries.length).toBe(1);
	});

	test('takes no place that was stopped, nor any of an app removed', async () => {
		const stopped = await placedThread();
		await claimOnly('worker-a', [stopped.placeId]);
		expect(unwrap(await stopSlackDelivery(stopped.placeId, 'worker-a', 'channel_not_found'))).toBe(
			true,
		);
		expect(
			await db.slackThreadPlace.findUniqueOrThrow({where: {id: stopped.placeId}}),
		).toMatchObject({stoppedWhy: 'channel_not_found', claimedBy: null});
		expect((await claimOnly('worker-a', [stopped.placeId])).length).toBe(0);

		const other = await placedThread();
		unwrap(await markSlackAppRemoved(appId));
		expect((await claimOnly('worker-a', [other.placeId])).length).toBe(0);
		await db.slackApp.update({where: {id: appId}, data: {botToken: 'sealed-bot', removedAt: null}});
		expect((await claimOnly('worker-a', [other.placeId])).length).toBe(1);
		unwrap(await releaseSlackDelivery(other.placeId, 'worker-a', 0, 0));
	});

	test('a place let go to wait is not taken before then', async () => {
		const {placeId} = await placedThread();
		await claimOnly('worker-a', [placeId]);
		unwrap(await releaseSlackDelivery(placeId, 'worker-a', 30_000, 2));
		expect(await db.slackThreadPlace.findUniqueOrThrow({where: {id: placeId}})).toMatchObject({
			attempts: 2,
			claimedBy: null,
		});
		expect((await claimOnly('worker-a', [placeId])).length).toBe(0);
	});

	// The place with everything in its thread delivered, its session last set to `status`, `ago` ms back.
	async function settled(
		place: {placeId: string; threadId: string},
		status: 'processing' | 'active' | 'suspended' | null,
		ago = 0,
	) {
		const last = await db.agentEntry.aggregate({
			where: {threadId: place.threadId},
			_max: {seq: true},
		});
		await db.slackThreadPlace.update({
			where: {id: place.placeId},
			data: {
				deliveredSeq: last._max.seq ?? 0,
				sessionStatus: status,
				sessionSetAt: status === null ? null : new Date(Date.now() - ago),
				sessionAttempts: 0,
				sessionRetryAt: null,
			},
		});
	}

	const taken = async (placeId: string) => {
		const claimed = await claimOnly('worker-a', [placeId]);
		for (const place of claimed) {
			unwrap(await releaseSlackDelivery(place.id, 'worker-a', 0, 0));
		}
		return claimed.length === 1;
	};

	test('takes a place whose session is due with nothing to deliver, and only then', async () => {
		const place = await placedThread();

		// Nothing set yet: due.
		await settled(place, null);
		expect(await taken(place.placeId)).toBe(true);

		// Set, and nothing changed since: not due.
		await settled(place, 'active');
		expect(await taken(place.placeId)).toBe(false);

		// The thread waits for the member now; and the member pressed Done after.
		await db.agentThread.update({where: {id: place.threadId}, data: {waitingForMember: true}});
		expect(await taken(place.placeId)).toBe(true);
		await settled(place, 'suspended');
		expect(await taken(place.placeId)).toBe(false);
		await db.agentThread.update({where: {id: place.threadId}, data: {waitingForMember: false}});
		expect(await taken(place.placeId)).toBe(true);
	});

	test('takes a place set processing once its agent is no longer at work, or to renew it', async () => {
		const place = await placedThread();
		const turn = await db.agentJob.create({
			data: {threadId: place.threadId, kind: 'inference', status: 'running', claimedBy: 'worker-x'},
		});
		await settled(place, 'processing');
		expect(await taken(place.placeId)).toBe(false);

		// At work for longer than the renewal.
		await settled(place, 'processing', RENEW + 1_000);
		expect(await taken(place.placeId)).toBe(true);

		// Asleep, its only job a wake-up due later, which is at work all the same.
		await db.agentJob.update({where: {id: turn.id}, data: {status: 'done'}});
		const wake = await db.agentJob.create({
			data: {
				threadId: place.threadId,
				kind: 'wake',
				runAt: new Date(Date.now() + 60 * 60_000),
			},
		});
		await settled(place, 'processing');
		expect(await taken(place.placeId)).toBe(false);

		// Stopped.
		await db.agentJob.update({where: {id: wake.id}, data: {status: 'done'}});
		expect(await taken(place.placeId)).toBe(true);
	});

	test('keeps a place processing while a sub-agent of its thread works, and takes one set otherwise then', async () => {
		const place = await placedThread();
		const sub = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId,
				userId: owner,
				parentThreadId: chat.id,
				subAgentOfId: place.threadId,
				title: 'Fares to Lyon',
			},
		});
		const job = await db.agentJob.create({
			data: {threadId: sub.id, kind: 'inference', status: 'running', claimedBy: 'worker-x'},
		});
		await settled(place, 'processing');
		expect(await taken(place.placeId)).toBe(false);
		expect(unwrap(await readSlackSessionState(place.threadId, new Date()))).toMatchObject({
			state: {kind: 'stopped'},
			subAgentsAtWork: true,
		});

		await settled(place, 'active');
		expect(await taken(place.placeId)).toBe(true);

		await db.agentJob.update({where: {id: job.id}, data: {status: 'done'}});
		await settled(place, 'processing');
		expect(await taken(place.placeId)).toBe(true);
		expect(unwrap(await readSlackSessionState(place.threadId, new Date()))?.subAgentsAtWork).toBe(
			false,
		);
	});

	test('takes a place whose thread was named since its session was given a title, until it is renamed', async () => {
		const place = await placedThread();
		await settled(place, 'active');
		await db.slackThreadPlace.update({
			where: {id: place.placeId},
			data: {sessionTitle: 'plan a trip to lyon'},
		});
		expect(await taken(place.placeId)).toBe(true);

		const thread = await db.agentThread.findUniqueOrThrow({where: {id: place.threadId}});
		unwrap(await noteSlackSessionRenamed(place.placeId, thread.title ?? ''));
		expect(await taken(place.placeId)).toBe(false);
	});

	test('takes no place for its session while its app’s sessions are off, or it waits to try again', async () => {
		const place = await placedThread();
		await settled(place, null);
		unwrap(await turnSlackSessionsOff(appId, new Date(Date.now() + 60_000)));
		expect(await taken(place.placeId)).toBe(false);
		unwrap(await turnSlackSessionsOff(appId, new Date(Date.now() - 1_000)));
		expect(await taken(place.placeId)).toBe(true);

		unwrap(await noteSlackSessionFailed(place.placeId, 2, new Date(Date.now() + 60_000)));
		expect(await taken(place.placeId)).toBe(false);
		expect(await db.slackThreadPlace.findUniqueOrThrow({where: {id: place.placeId}})).toMatchObject(
			{
				sessionAttempts: 2,
			},
		);

		// Something to deliver is taken all the same.
		await answer(place.threadId, 'Booked.');
		expect(await taken(place.placeId)).toBe(true);
	});

	test('notes the status set, and reads where a thread stands with the last entry', async () => {
		const place = await placedThread();
		unwrap(await noteSlackSessionFailed(place.placeId, 3, new Date(Date.now() + 60_000)));
		const at = new Date();
		unwrap(await noteSlackSessionSet(place.placeId, 'suspended', at, {title: 'Trip to Lyon'}));
		const read = unwrap(await getSlackSessionPlace(place.threadId));
		expect(read).toMatchObject({
			id: place.placeId,
			channel: 'D01',
			session: {status: 'suspended', title: 'Trip to Lyon', setAt: at, attempts: 0, retryAt: null},
			app: {id: appId},
		});
		// Set again, its title kept.
		unwrap(await noteSlackSessionSet(place.placeId, 'active', at, null));
		expect(unwrap(await getSlackSessionPlace(place.threadId))?.session).toMatchObject({
			status: 'active',
			title: 'Trip to Lyon',
		});

		const said = await answer(place.threadId, 'Booked.');
		await db.agentJob.create({data: {threadId: place.threadId, kind: 'inference'}});
		const state = unwrap(await readSlackSessionState(place.threadId, new Date()));
		expect(state).toMatchObject({
			state: {kind: 'working'},
			waitingForMember: false,
			alerts: 0,
			subAgentsAtWork: false,
			lastSeq: said.seq,
		});
		expect(state?.title).toStartWith('Plan trip');
		await db.agentJob.updateMany({where: {threadId: place.threadId}, data: {status: 'done'}});
		expect(unwrap(await readSlackSessionState(place.threadId, new Date()))?.state).toEqual({
			kind: 'stopped',
		});
	});

	test('reads no place for a session where it was stopped, or its app removed', async () => {
		const stopped = await placedThread();
		await db.slackThreadPlace.update({where: {id: stopped.placeId}, data: {stoppedAt: new Date()}});
		expect(unwrap(await getSlackSessionPlace(stopped.threadId))).toBeNull();

		const other = await placedThread();
		unwrap(await markSlackAppRemoved(appId));
		expect(unwrap(await getSlackSessionPlace(other.threadId))).toBeNull();
		await db.slackApp.update({where: {id: appId}, data: {botToken: 'sealed-bot', removedAt: null}});
		expect(unwrap(await getSlackSessionPlace(other.threadId))?.id).toBe(other.placeId);
	});
});
