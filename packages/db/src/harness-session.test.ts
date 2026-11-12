import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	appendPersonMessage,
	appendTurnEntries,
	claimJob,
	completeInference,
	completeToolJob,
	createPersona,
	ensureMemberThread,
	finishJob,
	getJobThread,
	getThreadPersonaModel,
	listEntries,
	listOpenJobs,
	listSubAgents,
	messageSubAgentInline,
	scheduleWake,
	startSubAgentInline,
	tellParentInline,
	type ClaimedJob,
	type JobRow,
	type ThreadRow,
} from './harness';

// What a harness that runs its tools itself writes, against the local database, as harness.test.ts
// runs: with the database up and the environment loaded, `bun --env-file=../../.env test` from
// this package; skipped without DATABASE_URL. A turn's output appended as it goes, the session
// kept on the thread as the job ends, a sleep as a wake job, and what the calls a harness runs
// itself write beside the log, each fenced by the turn's job. Everything made here is one
// organization's, deleted at the end.
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

// The next two jobs due, both claimed by `workerId`, one of each thread: due at once, in either
// order.
async function claimBoth(
	workerId: string,
	parentId: string,
	subId: string,
): Promise<{parent: JobRow; sub: JobRow}> {
	const claimed = [
		unwrap(await claimJob(workerId, 60_000)),
		unwrap(await claimJob(workerId, 60_000)),
	];
	const parent = claimed.find((job) => job?.threadId === parentId);
	const sub = claimed.find((job) => job?.threadId === subId);
	if (!parent || !sub) {
		throw new Error(`expected a job of each, got ${JSON.stringify(claimed)}`);
	}
	return {parent, sub};
}

describe.skipIf(!databaseUrl)('a turn written as it goes, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let thread: ThreadRow;

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
		thread = unwrap(await ensureMemberThread({orgId, agentId, personaId: persona.id, userId}));
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
		unwrap(await appendPersonMessage(thread.id, 'Find my invoices', readyForInference));
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
						context: 'The time now is 2026-10-21T10:00:00.000Z.',
					},
					{kind: 'tool_result', callId: 'c1', text: 'Three invoices.', isError: false},
				]),
			),
		).toBe(true);
		// The person speaks while the turn runs: pending until it ends.
		unwrap(await appendPersonMessage(thread.id, 'Also September', readyForInference));
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
			context: 'The time now is 2026-10-21T10:00:00.000Z.',
		});
		expect(during[3]).toMatchObject({
			toolCalls: null,
			inputTokens: 12,
			outputTokens: null,
			system: null,
			context: null,
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
		const open = unwrap(await listOpenJobs(thread.id));
		expect(open.map((candidate) => [candidate.kind, candidate.status])).toEqual([
			['inference', 'queued'],
		]);

		// The next turn ends with a session of nothing, and the job is still ended.
		const next = await claimFor('worker-b', thread.id);
		expect(next.id).toBe(open[0]?.id ?? '');
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
						context: null,
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
		expect(unwrap(await listOpenJobs(thread.id))).toEqual([]);

		// A session that was never one reads as none.
		await db.agentThread.update({where: {id: thread.id}, data: {harnessSession: '{"id":4}'}});
		expect(unwrap(await getJobThread(thread.id))).toMatchObject({harnessSession: null});
	});

	test('a sleep the harness answered itself is a wake job: one per thread, moved earlier, never later; a message pulls it to now and no second turn is queued; and a running wake-up holds what lands', async () => {
		const task = {
			orgId,
			agentId,
			ownerUserId: userId,
			personaId: thread.personaId,
			parentId: null,
			title: 'Watch the mailbox',
			goal: 'Tell me when the invoice comes.',
			via: 'harness' as const,
		};
		unwrap(await appendPersonMessage(thread.id, 'Watch for the invoice', readyForInference));
		const turn = await claimFor('worker-c', thread.id);
		unwrap(
			await completeInference(
				turn.id,
				'worker-c',
				thread.id,
				{
					text: 'Watching.',
					toolCalls: [{id: 's1', name: 'create_subagent', arguments: '{}'}],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
					context: null,
				},
				{
					plans: {
						s1: {
							kind: 'create_subagent',
							start: {
								callId: 's1',
								title: 'Watch the mailbox',
								task,
								entries: [{kind: 'person', text: 'Tell me when the invoice comes.'}],
							},
							started: (id) => `Started, id ${id}.`,
						},
					},
				},
				readyForInference,
			),
		);
		const [sub] = unwrap(await listSubAgents(thread.id));
		if (!sub) {
			throw new Error('expected a sub-agent');
		}

		// The sub-agent's turn: it sleeps for an hour, then asks for half an hour; a later time changes nothing.
		const first = await claimFor('worker-d', sub.id);
		const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
		const inHalfAnHour = new Date(Date.now() + 30 * 60 * 1000);
		const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
		expect(unwrap(await scheduleWake(first.id, 'worker-z', sub.id, inAnHour))).toBe(false);
		expect(unwrap(await scheduleWake(first.id, 'worker-d', sub.id, inAnHour))).toBe(true);
		expect(unwrap(await scheduleWake(first.id, 'worker-d', sub.id, inHalfAnHour))).toBe(true);
		expect(unwrap(await scheduleWake(first.id, 'worker-d', sub.id, inTwoHours))).toBe(true);
		const wakes = (await db.agentJob.findMany({where: {threadId: sub.id, kind: 'wake'}})).map(
			(job) => [job.status, job.runAt],
		);
		expect(wakes).toEqual([['queued', inHalfAnHour]]);

		unwrap(
			await appendTurnEntries(first.id, 'worker-d', sub.id, [
				{
					kind: 'assistant',
					text: '',
					toolCalls: [{id: 'z1', name: 'sleep_until', arguments: '{}'}],
				},
				{kind: 'tool_result', callId: 'z1', text: 'Sleeping.', isError: false},
			]),
		);
		unwrap(
			await completeInference(first.id, 'worker-d', sub.id, null, {plans: {}}, readyForInference, {
				harness: 'claude-agent-sdk',
				session: {id: 'session-2', state: null},
			}),
		);
		// Asleep until the wake-up, with no turn queued beside it: the wake-up is the turn.
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({
			kind: 'asleep',
			until: inHalfAnHour,
		});
		expect(unwrap(await listOpenJobs(sub.id)).map((job) => job.kind)).toEqual(['wake']);

		// The parent sends a message: the wake-up is due now, and the message is in the log for it to read.
		const answer = await claimFor('worker-e', thread.id);
		unwrap(
			await completeInference(
				answer.id,
				'worker-e',
				thread.id,
				{
					text: '',
					toolCalls: [{id: 'm1', name: 'send_to_subagent', arguments: '{}'}],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
					context: null,
				},
				{
					plans: {
						m1: {
							kind: 'send_to_subagent',
							subAgentId: sub.id,
							entry: {kind: 'person', text: 'Any sign of it?'},
							sent: (subAgent) => ({text: `Sent; it was ${subAgent?.state.kind}.`, isError: false}),
						},
					},
				},
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			callId: 'm1',
			text: 'Sent; it was asleep.',
		});
		const open = unwrap(await listOpenJobs(sub.id));
		expect(open.map((job) => job.kind)).toEqual(['wake']);
		expect(open[0]?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'working'});
		expect(unwrap(await listEntries(sub.id)).at(-1)).toMatchObject({
			kind: 'person',
			text: 'Any sign of it?',
		});

		// The wake-up is claimed as any job is; while it runs, what the parent sends waits.
		const both = await claimBoth('worker-f', thread.id, sub.id);
		const woken = both.sub;
		expect(woken.kind).toBe('wake');
		unwrap(
			await completeInference(
				both.parent.id,
				'worker-f',
				thread.id,
				{
					text: '',
					toolCalls: [{id: 'm2', name: 'send_to_subagent', arguments: '{}'}],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
					context: null,
				},
				{
					plans: {
						m2: {
							kind: 'send_to_subagent',
							subAgentId: sub.id,
							entry: {kind: 'person', text: 'Still nothing?'},
							sent: (subAgent) => ({text: `Sent; it was ${subAgent?.state.kind}.`, isError: false}),
						},
					},
				},
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			text: 'Sent; it was working.',
		});
		expect(unwrap(await listEntries(sub.id)).at(-1)).toMatchObject({text: 'Any sign of it?'});

		// The wake-up ends as a turn does: the message takes its place, and wakes the agent again.
		unwrap(
			await appendTurnEntries(woken.id, 'worker-f', sub.id, [
				{kind: 'assistant', text: 'Nothing yet.', toolCalls: null},
			]),
		);
		unwrap(
			await completeInference(woken.id, 'worker-f', sub.id, null, {plans: {}}, readyForInference),
		);
		expect(
			unwrap(await listEntries(sub.id))
				.slice(-2)
				.map((entry) => [entry.kind, entry.text]),
		).toEqual([
			['assistant', 'Nothing yet.'],
			['person', 'Still nothing?'],
		]);
		expect(unwrap(await listOpenJobs(sub.id)).map((job) => [job.kind, job.status])).toEqual([
			['inference', 'queued'],
		]);
		// The parent's turn, woken by the answers to its calls, is left for the next test.
	});

	test('a sub-agent started, a message to one and a message to the parent, each from the running turn’s job, land as the planned calls would, pending where a turn runs, and the job goes on; a worker that lost the job writes none', async () => {
		const [sub] = unwrap(await listSubAgents(thread.id));
		if (!sub) {
			throw new Error('expected a sub-agent');
		}
		// Both turns under way: the parent's and the sub-agent's.
		const {parent, sub: subTurn} = await claimBoth('worker-g', thread.id, sub.id);
		const parentJob = (workerId: string) => ({jobId: parent.id, workerId, threadId: thread.id});
		const subJob = (workerId: string) => ({jobId: subTurn.id, workerId, threadId: sub.id});
		const start = {
			callId: 'n1',
			title: 'File the invoices',
			task: {
				orgId,
				agentId,
				ownerUserId: userId,
				personaId: thread.personaId,
				parentId: null,
				title: 'File the invoices',
				goal: 'Save them to the vault.',
				via: 'harness' as const,
			},
			entries: [{kind: 'person' as const, text: 'Save them to the vault.'}] as [
				{kind: 'person'; text: string},
			],
		};

		expect(
			unwrap(await startSubAgentInline(parentJob('worker-z'), start, readyForInference)),
		).toBeNull();
		expect(
			unwrap(
				await messageSubAgentInline(
					parentJob('worker-z'),
					sub.id,
					{kind: 'person', text: 'x'},
					readyForInference,
				),
			),
		).toBeNull();
		expect(
			unwrap(
				await tellParentInline(subJob('worker-z'), {text: 'x', isError: false}, readyForInference),
			),
		).toBe(false);
		expect(unwrap(await listSubAgents(thread.id))).toHaveLength(1);

		// A sub-agent started: its thread, its task and its brief, which wakes it.
		const startedId = unwrap(
			await startSubAgentInline(parentJob('worker-g'), start, readyForInference),
		);
		expect(startedId).not.toBeNull();
		const started = unwrap(await listSubAgents(thread.id)).find(
			(candidate) => candidate.id === startedId,
		);
		expect(started).toMatchObject({
			parentThreadId: thread.id,
			parentCallId: 'n1',
			title: 'File the invoices',
			state: {kind: 'working'},
		});
		expect(
			unwrap(await listEntries(startedId ?? '')).map((entry) => [entry.kind, entry.text]),
		).toEqual([['person', 'Save them to the vault.']]);
		expect(
			await db.agentTask.findUniqueOrThrow({where: {id: started?.taskId ?? ''}}),
		).toMatchObject({
			...start.task,
			finishedAt: null,
		});
		expect(
			unwrap(await listOpenJobs(startedId ?? '')).map((job) => [job.kind, job.status]),
		).toEqual([['inference', 'queued']]);

		// A message to the sub-agent at work: it waits for its turn, and its sleep, had it one, is due now.
		const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
		unwrap(await scheduleWake(subTurn.id, 'worker-g', sub.id, inAnHour));
		const before = unwrap(await listEntries(sub.id)).length;
		expect(
			unwrap(
				await messageSubAgentInline(
					parentJob('worker-g'),
					'no-such-thread',
					{kind: 'person', text: 'x'},
					readyForInference,
				),
			),
		).toEqual({subAgent: null});
		const sent = unwrap(
			await messageSubAgentInline(
				parentJob('worker-g'),
				sub.id,
				{kind: 'person', text: 'Still there?'},
				readyForInference,
			),
		);
		expect(sent?.subAgent).toMatchObject({id: sub.id, state: {kind: 'working'}});
		expect(unwrap(await listEntries(sub.id))).toHaveLength(before);
		expect(await db.agentEntry.count({where: {threadId: sub.id, pending: true}})).toBe(1);
		const wake = await db.agentJob.findFirst({
			where: {threadId: sub.id, kind: 'wake', status: 'queued'},
		});
		expect(wake?.runAt.getTime()).toBeLessThanOrEqual(Date.now());

		// A message to the parent, whose turn runs: it waits too.
		const parentBefore = unwrap(await listEntries(thread.id)).length;
		expect(
			unwrap(
				await tellParentInline(
					subJob('worker-g'),
					{text: 'Found it.', isError: false},
					readyForInference,
				),
			),
		).toBe(true);
		expect(unwrap(await listEntries(thread.id))).toHaveLength(parentBefore);
		expect(await db.agentEntry.count({where: {threadId: thread.id, pending: true}})).toBe(1);
		// Both jobs still run.
		expect(
			await db.agentJob.count({where: {id: {in: [parent.id, subTurn.id]}, status: 'running'}}),
		).toBe(2);

		// As each turn ends, what waited takes its place and wakes the agent: the sub-agent's wake-up
		// is turn enough, the parent gets a turn.
		unwrap(
			await appendTurnEntries(subTurn.id, 'worker-g', sub.id, [
				{kind: 'assistant', text: 'Checking.', toolCalls: null},
			]),
		);
		unwrap(
			await completeInference(subTurn.id, 'worker-g', sub.id, null, {plans: {}}, readyForInference),
		);
		expect(
			unwrap(await listEntries(sub.id))
				.slice(-2)
				.map((entry) => [entry.kind, entry.text]),
		).toEqual([
			['assistant', 'Checking.'],
			['person', 'Still there?'],
		]);
		expect(unwrap(await listOpenJobs(sub.id)).map((job) => job.kind)).toEqual(['wake']);

		unwrap(
			await completeInference(
				parent.id,
				'worker-g',
				thread.id,
				{
					text: 'Noted.',
					toolCalls: [],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
					context: null,
				},
				{plans: {}},
				readyForInference,
			),
		);
		expect(
			unwrap(await listEntries(thread.id))
				.slice(-2)
				.map((entry) => [entry.kind, entry.callId, entry.text]),
		).toEqual([
			['assistant', null, 'Noted.'],
			['event', sub.parentCallId, 'Found it.'],
		]);
		expect(
			unwrap(await listOpenJobs(thread.id))
				.filter((job) => job.threadId === thread.id)
				.map((job) => [job.kind, job.status]),
		).toEqual([['inference', 'queued']]);
	});

	// A thread of its own with another persona, and the queue emptied of what the tests before left
	// due, so that what is claimed next is this thread's or nothing.
	async function quietThread(name: string): Promise<ThreadRow> {
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
		return unwrap(await ensureMemberThread({orgId, agentId, personaId: persona.id, userId}));
	}

	test('a wake-up already due is not claimed while the turn that asked for it runs, nor while that turn waits for another worker after its own died, and is once the turn has ended', async () => {
		const quiet = await quietThread('Wakes');
		unwrap(await appendPersonMessage(quiet.id, 'Check back in a second', readyForInference));
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
		const quiet = await quietThread('Capped');
		unwrap(await appendPersonMessage(quiet.id, 'Hi', readyForInference));
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
					context: null,
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

		unwrap(await appendPersonMessage(quiet.id, 'And?', readyForInference));
		const uncapped = unwrap(await claimJob('worker-k', 60_000));
		expect([uncapped?.kind, uncapped?.capped]).toEqual(['inference', false]);
		unwrap(await finishJob(uncapped?.id ?? '', 'worker-k'));
	});
});
