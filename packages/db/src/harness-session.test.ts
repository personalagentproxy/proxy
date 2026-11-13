import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	appendTurnEntries,
	claimJob,
	completeInference,
	completeToolJob,
	createPersona,
	ensureMemberChat,
	finishJob,
	getChatThread,
	getJobThread,
	getThreadPersonaModel,
	listEntries,
	openThread,
	replyInThread,
	scheduleWake,
	type ClaimedJob,
	type ThreadRow,
} from './harness';

// What a harness that runs its tools itself writes, against the local database, as harness.test.ts
// runs: with the database up and the environment loaded, `bun --env-file=../../.env test` from
// this package; skipped without DATABASE_URL. A turn's output appended as it goes, the session
// kept on the thread as the job ends, and a sleep as a wake job, each fenced by the turn's job.
// Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

// The next job due, which must be `threadId`'s, claimed by `workerId`.
async function claimFor(workerId: string, threadId: string): Promise<ClaimedJob> {
	const job = unwrap(await claimJob(workerId, 60_000));
	if (!job || job.threadId !== threadId) {
		throw new Error(`expected a job of ${threadId}, got ${JSON.stringify(job)}`);
	}
	return job;
}

// The thread's jobs still to run or running, the earliest due first.
function openJobs(threadId: string) {
	return db.agentJob.findMany({
		where: {threadId, status: {in: ['queued', 'running']}},
		orderBy: {runAt: 'asc'},
	});
}

// What the member replies in the thread, which wakes it.
async function reply(thread: ThreadRow, text: string): Promise<void> {
	unwrap(await replyInThread(thread.parentThreadId ?? '', thread.id, text, readyForInference));
}

describe.skipIf(!databaseUrl)('a turn written as it goes, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let thread: ThreadRow;

	// Opens a thread in a chat of the member's with the persona, with what they say, which wakes it.
	async function open(personaId: string, text: string): Promise<ThreadRow> {
		const chat = unwrap(await ensureMemberChat({orgId, agentId, personaId, userId}));
		const task = {
			orgId,
			agentId,
			ownerUserId: userId,
			personaId,
			parentId: null,
			title: text,
			goal: text,
			via: 'harness' as const,
		};
		const opened = unwrap(await openThread(chat.id, text, {title: text, task}, readyForInference));
		if (!opened) {
			throw new Error('no chat');
		}
		return opened.thread;
	}

	beforeAll(async () => {
		const user = await db.user.create({
			data: {email: `harness-session-test-${stamp}@example.test`},
		});
		userId = user.id;
		const org = await db.organization.create({
			data: {
				name: 'Harness session test',
				slug: `harness-session-test-${stamp}`,
				ownerUserId: userId,
			},
		});
		orgId = org.id;
		const agent = await db.agent.create({
			data: {
				orgId,
				providerId: 'built-in',
				name: 'Built in',
				username: `harness-session-test-${stamp}`,
				passwordHash: '',
			},
		});
		agentId = agent.id;
		const persona = unwrap(
			await createPersona(orgId, userId, {
				name: 'Sessions',
				look: {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2},
				color: 'teal',
			}),
		);
		thread = await open(persona.id, 'Find my invoices');
	});

	afterAll(async () => {
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
		await db.$disconnect();
	});

	test('a thread starts with no harness and no session', () => {
		expect(thread).toMatchObject({harness: null, harnessSession: null});
	});

	test('the turn’s entries land in order, never pending, from the job that runs it alone; what the person says meanwhile waits; and the job ends with the session kept, nothing more written', async () => {
		const job = await claimFor('worker-a', thread.id);
		expect(job.kind).toBe('inference');

		// Another worker's write, or a stale one, goes nowhere.
		expect(
			unwrap(
				await appendTurnEntries(job.id, 'worker-z', thread.id, [
					{kind: 'assistant', text: 'Not mine.', toolCalls: null},
				]),
			),
		).toBe(false);

		expect(
			unwrap(
				await appendTurnEntries(job.id, 'worker-a', thread.id, [
					{
						kind: 'assistant',
						text: '',
						toolCalls: [{id: 'c1', name: 'read', arguments: '{"tool":"list"}'}],
						inputTokens: 10,
						outputTokens: 2,
						system: 'You are signed in.',
					},
					{kind: 'tool_result', callId: 'c1', text: 'Three invoices.', isError: false},
				]),
			),
		).toBe(true);
		// The person speaks while the turn runs: pending until it ends.
		await reply(thread, 'Also September');
		expect(
			unwrap(
				await appendTurnEntries(job.id, 'worker-a', thread.id, [
					{kind: 'assistant', text: 'Three invoices from Dana.', toolCalls: [], inputTokens: 12},
				]),
			),
		).toBe(true);

		const during = unwrap(await listEntries(thread.id));
		expect(
			during.map((entry) => [entry.kind, entry.text, entry.callId, entry.jobId, entry.pending]),
		).toEqual([
			['person', 'Find my invoices', null, null, false],
			['assistant', '', null, job.id, false],
			['tool_result', 'Three invoices.', 'c1', job.id, false],
			['assistant', 'Three invoices from Dana.', null, job.id, false],
		]);
		expect(during[1]).toMatchObject({
			toolCalls: [{id: 'c1', name: 'read', arguments: '{"tool":"list"}'}],
			inputTokens: 10,
			outputTokens: 2,
			system: 'You are signed in.',
		});
		expect(during[3]).toMatchObject({
			toolCalls: null,
			inputTokens: 12,
			outputTokens: null,
			system: null,
		});
		expect(await db.agentEntry.count({where: {threadId: thread.id, pending: true}})).toBe(1);

		const session = {id: 'session-1', state: {lastSeq: 4}};
		expect(
			unwrap(
				await completeInference(
					job.id,
					'worker-a',
					thread.id,
					null,
					{plans: {}},
					readyForInference,
					{harness: 'claude-agent-sdk', session},
				),
			),
		).toBe(true);

		// Nothing more was written for the turn; the message took its place after it, and woke the agent.
		const after = unwrap(await listEntries(thread.id));
		expect(after.map((entry) => [entry.kind, entry.text])).toEqual([
			...during.map((entry) => [entry.kind, entry.text]),
			['person', 'Also September'],
		]);
		expect(unwrap(await getJobThread(thread.id))).toMatchObject({
			harness: 'claude-agent-sdk',
			harnessSession: session,
		});
		const queued = await openJobs(thread.id);
		expect(queued.map((candidate) => [candidate.kind, candidate.status])).toEqual([
			['inference', 'queued'],
		]);

		// The next turn ends with a session of nothing, and the job is still ended.
		const next = await claimFor('worker-b', thread.id);
		expect(next.id).toBe(queued[0]?.id ?? '');
		expect(
			unwrap(
				await completeInference(
					next.id,
					'worker-b',
					thread.id,
					{
						text: 'Two from September.',
						toolCalls: [],
						inputTokens: 1,
						outputTokens: 1,
						system: null,
					},
					{plans: {}},
					readyForInference,
					{harness: 'proxy', session: null},
				),
			),
		).toBe(true);
		expect(unwrap(await getJobThread(thread.id))).toMatchObject({
			harness: 'proxy',
			harnessSession: null,
		});
		expect(await openJobs(thread.id)).toEqual([]);

		// A session that was never one reads as none.
		await db.agentThread.update({where: {id: thread.id}, data: {harnessSession: '{"id":4}'}});
		expect(unwrap(await getJobThread(thread.id))).toMatchObject({harnessSession: null});
	});

	test('a sleep the harness answered itself is a wake job: one per thread, moved earlier, never later; a reply pulls it to now and no second turn is queued; and a running wake-up holds what lands', async () => {
		const chatOf = (one: ThreadRow) => one.parentThreadId ?? '';
		await reply(thread, 'Watch for the invoice');

		// The turn sleeps for an hour, then asks for half an hour; a later time changes nothing.
		const first = await claimFor('worker-d', thread.id);
		const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
		const inHalfAnHour = new Date(Date.now() + 30 * 60 * 1000);
		const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
		expect(unwrap(await scheduleWake(first.id, 'worker-z', thread.id, inAnHour))).toBe(false);
		expect(unwrap(await scheduleWake(first.id, 'worker-d', thread.id, inAnHour))).toBe(true);
		expect(unwrap(await scheduleWake(first.id, 'worker-d', thread.id, inHalfAnHour))).toBe(true);
		expect(unwrap(await scheduleWake(first.id, 'worker-d', thread.id, inTwoHours))).toBe(true);
		const wakes = (await db.agentJob.findMany({where: {threadId: thread.id, kind: 'wake'}})).map(
			(job) => [job.status, job.runAt],
		);
		expect(wakes).toEqual([['queued', inHalfAnHour]]);

		unwrap(
			await appendTurnEntries(first.id, 'worker-d', thread.id, [
				{
					kind: 'assistant',
					text: '',
					toolCalls: [{id: 'z1', name: 'sleep_until', arguments: '{}'}],
				},
				{kind: 'tool_result', callId: 'z1', text: 'Sleeping.', isError: false},
			]),
		);
		unwrap(
			await completeInference(
				first.id,
				'worker-d',
				thread.id,
				null,
				{plans: {}},
				readyForInference,
				{
					harness: 'claude-agent-sdk',
					session: {id: 'session-2', state: null},
				},
			),
		);
		// Asleep until the wake-up, with no turn queued beside it: the wake-up is the turn.
		expect(unwrap(await getChatThread(chatOf(thread), thread.id, []))?.state).toEqual({
			kind: 'asleep',
			until: inHalfAnHour,
		});
		expect((await openJobs(thread.id)).map((job) => job.kind)).toEqual(['wake']);

		// The member replies: the wake-up is due now, and the reply is in the log for it to read.
		await reply(thread, 'Any sign of it?');
		const due = await openJobs(thread.id);
		expect(due.map((job) => job.kind)).toEqual(['wake']);
		expect(due[0]?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
		expect(unwrap(await getChatThread(chatOf(thread), thread.id, []))?.state).toEqual({
			kind: 'working',
		});
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'person',
			text: 'Any sign of it?',
		});

		// The wake-up is claimed as any job is; while it runs, what the member replies waits.
		const woken = await claimFor('worker-f', thread.id);
		expect(woken.kind).toBe('wake');
		await reply(thread, 'Still nothing?');
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({text: 'Any sign of it?'});

		// The wake-up ends as a turn does: the reply takes its place, and wakes the agent again.
		unwrap(
			await appendTurnEntries(woken.id, 'worker-f', thread.id, [
				{kind: 'assistant', text: 'Nothing yet.', toolCalls: null},
			]),
		);
		unwrap(
			await completeInference(
				woken.id,
				'worker-f',
				thread.id,
				null,
				{plans: {}},
				readyForInference,
			),
		);
		expect(
			unwrap(await listEntries(thread.id))
				.slice(-2)
				.map((entry) => [entry.kind, entry.text]),
		).toEqual([
			['assistant', 'Nothing yet.'],
			['person', 'Still nothing?'],
		]);
		expect((await openJobs(thread.id)).map((job) => [job.kind, job.status])).toEqual([
			['inference', 'queued'],
		]);
	});

	// A thread of its own, opened with `text` in a chat with another persona, and the queue emptied
	// of what the tests before left due, so that what is claimed next is this thread's or nothing.
	async function quietThread(name: string, text: string): Promise<ThreadRow> {
		for (
			let left = unwrap(await claimJob('worker-sweep', 60_000));
			left;
			left = unwrap(await claimJob('worker-sweep', 60_000))
		) {
			unwrap(await finishJob(left.id, 'worker-sweep'));
		}
		const persona = unwrap(
			await createPersona(orgId, userId, {
				name,
				look: {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2},
				color: 'red',
			}),
		);
		return open(persona.id, text);
	}

	test('a wake-up already due is not claimed while the turn that asked for it runs, nor while that turn waits for another worker after its own died, and is once the turn has ended', async () => {
		const quiet = await quietThread('Wakes', 'Check back in a second');
		const turn = await claimFor('worker-h', quiet.id);

		// The sleep asked for is over before the turn is: the wake-up is due at once.
		expect(
			unwrap(await scheduleWake(turn.id, 'worker-h', quiet.id, new Date(Date.now() - 1000))),
		).toBe(true);
		expect(unwrap(await claimJob('worker-i', 60_000))).toBeNull();

		// The turn's worker dies: the turn is what is claimed again, the wake-up still not.
		await db.agentJob.update({
			where: {id: turn.id},
			data: {leaseExpiresAt: new Date(Date.now() - 60_000)},
		});
		const again = await claimFor('worker-i', quiet.id);
		expect([again.id, again.kind, again.attempts]).toEqual([turn.id, 'inference', 2]);
		expect(unwrap(await claimJob('worker-j', 60_000))).toBeNull();

		unwrap(
			await appendTurnEntries(again.id, 'worker-i', quiet.id, [
				{
					kind: 'assistant',
					text: '',
					toolCalls: [{id: 'z9', name: 'sleep_until', arguments: '{}'}],
				},
				{kind: 'tool_result', callId: 'z9', text: 'Sleeping.', isError: false},
			]),
		);
		unwrap(
			await completeInference(again.id, 'worker-i', quiet.id, null, {plans: {}}, readyForInference),
		);

		const wake = await claimFor('worker-j', quiet.id);
		expect(wake.kind).toBe('wake');
		// One answer for the sleep in the log, the turn's own: nothing was closed beside it.
		expect(
			unwrap(await listEntries(quiet.id))
				.filter((entry) => entry.callId === 'z9')
				.map((entry) => entry.text),
		).toEqual(['Sleeping.']);
		unwrap(await finishJob(wake.id, 'worker-j'));
	});

	test('a claim told which harness is capped says whether the job is a turn of a persona on it, and one from a worker with no room for another leaves such a turn queued, taking the other jobs', async () => {
		const capped = (full: boolean) => ({harness: 'claude-agent-sdk', full});
		const quiet = await quietThread('Capped', 'Hi');
		const before = await claimFor('worker-k', quiet.id);
		// On the proxy harness, as a persona is made: no turn of the capped harness's.
		expect(before.capped).toBe(false);
		unwrap(
			await completeInference(
				before.id,
				'worker-k',
				quiet.id,
				{
					text: 'Looking.',
					toolCalls: [{id: 'r1', name: 'read', arguments: '{}'}],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
					ranOn: {harness: 'proxy', model: 'claude'},
				},
				{plans: {r1: {kind: 'job', runAt: new Date()}}},
				readyForInference,
			),
		);
		// The answer keeps what it ran on.
		expect(
			unwrap(await listEntries(quiet.id))
				.filter((entry) => entry.kind === 'assistant')
				.map((entry) => [entry.harness, entry.model]),
		).toEqual([['proxy', 'claude']]);

		// The persona is switched to the capped harness while the call is still to run: its job is
		// no turn, and is claimed by a worker with no room for one.
		await db.persona.update({
			where: {id: quiet.personaId},
			data: {harness: 'claude-agent-sdk', chatModel: 'opus'},
		});
		expect(unwrap(await getThreadPersonaModel(quiet))).toEqual({
			harness: 'claude-agent-sdk',
			chatModel: 'opus',
		});
		const tool = unwrap(await claimJob('worker-k', 60_000, capped(true)));
		expect([tool?.kind, tool?.capped]).toEqual(['tool', false]);
		unwrap(
			await completeToolJob(
				tool?.id ?? '',
				'worker-k',
				quiet.id,
				{callId: 'r1', text: 'rows', isError: false},
				readyForInference,
			),
		);

		// Its next turn is one: left queued by a worker that is full, claimed by one that isn't,
		// and by one that was told of no cap, which then says nothing of it.
		expect(unwrap(await claimJob('worker-k', 60_000, capped(true)))).toBeNull();
		const turn = unwrap(await claimJob('worker-k', 60_000, capped(false)));
		expect([turn?.kind, turn?.capped]).toEqual(['inference', true]);
		unwrap(await finishJob(turn?.id ?? '', 'worker-k'));

		await reply(quiet, 'And?');
		const uncapped = unwrap(await claimJob('worker-k', 60_000));
		expect([uncapped?.kind, uncapped?.capped]).toEqual(['inference', false]);
		unwrap(await finishJob(uncapped?.id ?? '', 'worker-k'));
	});
});
