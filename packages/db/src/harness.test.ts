import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	appendPersonMessage,
	appendSummary,
	claimJob,
	completeInference,
	completeToolJob,
	ensureFirstPersona,
	ensureMemberThread,
	failJob,
	finishJob,
	listEntries,
	listJobEvents,
	listOpenJobs,
	listAnswers,
	listSubAgents,
	markThreadRead,
	requeueJob,
	type JobRow,
	type NewEntry,
	type SubAgentRow,
	type SubAgentStop,
	type ThreadRow,
} from './harness';
import type {ToolCall} from '@proxy/utils/harness';

// What the harness writes, against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/harness.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end. The agent is woken as
// the api wakes it (@proxy/utils/harness readyForInference).
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

// What the agent says to a sub-agent.
function say(text: string): NewEntry {
	return {kind: 'person', text};
}

// A sub-agent's answer without calls, as the api composes it: the note marks it stopped.
function stop(text: string, isError = false): SubAgentStop {
	return {outcome: text, stopped: {text: `${text} (Stopped.)`, isError}, goingOn: {text, isError}};
}

// A turn of the parent's, with the calls it made.
function parentTurn(toolCalls: ToolCall[]) {
	return {text: '', toolCalls, inputTokens: 1, outputTokens: 1, system: null};
}

// A turn of a sub-agent's that says `text`, with no calls.
function subTurn(text: string) {
	return {text, toolCalls: [], inputTokens: 1, outputTokens: 1, system: null};
}

describe.skipIf(!databaseUrl)('the harness, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let thread: ThreadRow;

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `harness-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Harness test', slug: `harness-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		const agent = await db.agent.create({
			data: {
				orgId,
				providerId: 'built-in',
				name: 'Built in',
				username: `harness-test-${stamp}`,
				passwordHash: '',
			},
		});
		agentId = agent.id;
		const persona = unwrap(await ensureFirstPersona(orgId));
		thread = unwrap(await ensureMemberThread({orgId, agentId, personaId: persona.id, userId}));
	});

	// The next two jobs due, both claimed by `workerId`, one the parent's and one the sub-agent's:
	// due at once, in either order.
	async function claimBoth(
		workerId: string,
		subId: string,
	): Promise<{parent: JobRow; sub: JobRow}> {
		const claimed = [
			unwrap(await claimJob(workerId, 60_000)),
			unwrap(await claimJob(workerId, 60_000)),
		];
		const parent = claimed.find((job) => job?.threadId === thread.id);
		const sub = claimed.find((job) => job?.threadId === subId);
		if (!parent || !sub) {
			throw new Error(`expected a job of each, got ${JSON.stringify(claimed)}`);
		}
		return {parent, sub};
	}

	// Ends a turn of the parent's with nothing said and no calls.
	async function endParentTurn(job: JobRow, workerId: string): Promise<void> {
		expect(job.kind).toBe('inference');
		const done = await completeInference(
			job.id,
			workerId,
			thread.id,
			parentTurn([]),
			{plans: {}},
			readyForInference,
		);
		expect(unwrap(done)).toBe(true);
	}

	// The sub-agent's task as it is now.
	function taskOf(sub: ThreadRow) {
		return db.agentTask.findUniqueOrThrow({where: {id: sub.taskId ?? ''}});
	}

	afterAll(async () => {
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
		await db.$disconnect();
	});

	test('a claim is noted, and so is the finish: the answer carries its prompt and its job, a call’s answer at once and a summary the job too', async () => {
		unwrap(await appendPersonMessage(thread.id, 'Find my invoices', readyForInference));
		const job = unwrap(await claimJob('worker-a', 60_000));
		if (!job) {
			throw new Error('nothing to claim');
		}
		expect(job).toMatchObject({
			threadId: thread.id,
			kind: 'inference',
			claimedBy: 'worker-a',
			attempts: 1,
		});
		unwrap(
			await appendSummary(
				job.id,
				'worker-a',
				thread.id,
				{text: 'Nothing yet.', inputTokens: 5, outputTokens: 1},
				0,
			),
		);
		unwrap(
			await completeInference(
				job.id,
				'worker-a',
				thread.id,
				{
					text: 'Looking.',
					toolCalls: [
						{id: 'c0', name: 'send_to_subagent', arguments: '{"subagent":"x"}'},
						{id: 'c1', name: 'send_to_subagent', arguments: '{"subagent":"x","text":"Go."}'},
					],
					inputTokens: 10,
					outputTokens: 2,
					system: 'You are signed in.',
				},
				{
					plans: {
						c0: {kind: 'answer', text: 'Give subagent and text.', isError: true},
						c1: {kind: 'job', runAt: new Date()},
					},
				},
				readyForInference,
			),
		);

		const entries = unwrap(await listEntries(thread.id));
		expect(entries.map((entry) => [entry.kind, entry.jobId, entry.system, entry.callId])).toEqual([
			['person', null, null, null],
			['summary', job.id, null, null],
			['assistant', job.id, 'You are signed in.', null],
			['tool_result', job.id, null, 'c0'],
		]);
		const events = unwrap(await listJobEvents(thread.id));
		expect(events.map((event) => [event.jobId, event.kind, event.workerId, event.error])).toEqual([
			[job.id, 'claimed', 'worker-a', null],
			[job.id, 'done', 'worker-a', null],
		]);
		const claimed = events[0];
		const done = events[1];
		if (!claimed || !done) {
			throw new Error('two events');
		}
		expect(claimed.at.getTime()).toBeLessThanOrEqual(done.at.getTime());
	});

	test('a tool job’s result carries the job; a requeue says why; a failure says why, and its answer carries the job', async () => {
		const tool = unwrap(await claimJob('worker-b', 60_000));
		if (!tool || tool.kind !== 'tool' || tool.callId !== 'c1') {
			throw new Error(`expected the message’s tool job, got ${JSON.stringify(tool)}`);
		}
		unwrap(
			await completeToolJob(
				tool.id,
				'worker-b',
				thread.id,
				{
					callId: 'c1',
					text: 'Three invoices.',
					isError: false,
				},
				readyForInference,
			),
		);
		const next = unwrap(await claimJob('worker-c', 60_000));
		if (!next || next.kind !== 'inference') {
			throw new Error(`expected the next turn, got ${JSON.stringify(next)}`);
		}
		unwrap(
			await requeueJob(
				next.id,
				'worker-c',
				thread.id,
				new Date(),
				'The model could not be reached: down',
				readyForInference,
			),
		);
		const again = unwrap(await claimJob('worker-d', 60_000));
		if (!again || again.id !== next.id) {
			throw new Error(`expected the same turn again, got ${JSON.stringify(again)}`);
		}
		expect(again.attempts).toBe(2);
		unwrap(
			await failJob(
				again.id,
				'worker-d',
				'Given up after 4 attempts',
				() => ({kind: 'reply', text: 'Something went wrong on my side.'}),
				readyForInference,
			),
		);

		const entries = unwrap(await listEntries(thread.id));
		expect(entries.slice(-2).map((entry) => [entry.kind, entry.jobId, entry.isError])).toEqual([
			['tool_result', tool.id, false],
			['assistant', next.id, true],
		]);
		const events = unwrap(await listJobEvents(thread.id));
		expect(
			events.slice(2).map((event) => [event.jobId, event.kind, event.workerId, event.error]),
		).toEqual([
			[tool.id, 'claimed', 'worker-b', null],
			[tool.id, 'done', 'worker-b', null],
			[next.id, 'claimed', 'worker-c', null],
			[next.id, 'requeued', 'worker-c', 'The model could not be reached: down'],
			[next.id, 'claimed', 'worker-d', null],
			[next.id, 'failed', 'worker-d', 'Given up after 4 attempts'],
		]);
	});

	test('the persona’s last answer is unread until the thread is read up to it, never back, and what the person says after it reads nothing', async () => {
		const persona = unwrap(await ensureFirstPersona(orgId));
		const lastAnswer = async () =>
			unwrap(await listAnswers(orgId, userId)).find(
				(candidate) => candidate.personaId === persona.id,
			);
		const answer = async (workerId: string, text: string) => {
			const job = unwrap(await claimJob(workerId, 60_000));
			if (!job) {
				throw new Error('nothing to claim');
			}
			unwrap(
				await completeInference(
					job.id,
					workerId,
					thread.id,
					subTurn(text),
					{plans: {}},
					readyForInference,
				),
			);
			const last = await lastAnswer();
			if (last?.answer.text !== text) {
				throw new Error(`expected the answer ${text}, got ${JSON.stringify(last)}`);
			}
			return last.answer.id;
		};

		unwrap(await appendPersonMessage(thread.id, 'Anything new?', readyForInference));
		const first = await answer('worker-r', 'Nothing new.');
		expect((await lastAnswer())?.unread).toBe(true);

		unwrap(await appendPersonMessage(thread.id, 'And now?', readyForInference));
		expect(await lastAnswer()).toEqual({
			personaId: persona.id,
			personaName: persona.name,
			answer: {id: first, text: 'Nothing new.'},
			unread: true,
		});

		const second = await answer('worker-r2', 'Still nothing.');
		expect(unwrap(await markThreadRead(thread.id, first))).toBe(true);
		expect((await lastAnswer())?.unread).toBe(true);

		expect(unwrap(await markThreadRead(thread.id, second))).toBe(true);
		expect((await lastAnswer())?.unread).toBe(false);
		expect(unwrap(await markThreadRead(thread.id, first))).toBe(true);
		expect((await lastAnswer())?.unread).toBe(false);

		expect(unwrap(await markThreadRead(thread.id, 'no-such-entry'))).toBe(false);
		expect(unwrap(await markThreadRead('no-such-thread', second))).toBe(false);
	});

	test('a finish with nothing written is a done event too', async () => {
		unwrap(await appendPersonMessage(thread.id, 'Try again', readyForInference));
		const job = unwrap(await claimJob('worker-e', 60_000));
		if (!job) {
			throw new Error('nothing to claim');
		}
		unwrap(await finishJob(job.id, 'worker-e'));
		const events = unwrap(await listJobEvents(thread.id));
		expect(events.slice(-2).map((event) => [event.jobId, event.kind, event.workerId])).toEqual([
			[job.id, 'claimed', 'worker-e'],
			[job.id, 'done', 'worker-e'],
		]);
		expect(unwrap(await listOpenJobs(thread.id))).toEqual([]);
	});

	test('a sub-agent is started as the answer is written, with its task and brief; is sent messages as the answer is written, one waking it early; goes on to read one that came while it answered; stops with what it said, which reaches its parent; and is taken up again by a message, its task with it', async () => {
		const task = {
			orgId,
			agentId,
			ownerUserId: userId,
			personaId: thread.personaId,
			parentId: null,
			title: 'Find the invoices',
			goal: 'Search the mailbox for October invoices.',
			via: 'harness' as const,
		};
		unwrap(await appendPersonMessage(thread.id, 'Find my invoices', readyForInference));
		const turn = unwrap(await claimJob('worker-f', 60_000));
		if (!turn || turn.kind !== 'inference') {
			throw new Error(`expected a turn, got ${JSON.stringify(turn)}`);
		}
		unwrap(
			await completeInference(
				turn.id,
				'worker-f',
				thread.id,
				{
					text: 'Looking.',
					toolCalls: [{id: 's1', name: 'create_subagent', arguments: '{}'}],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
				},
				{
					plans: {
						s1: {
							kind: 'create_subagent',
							start: {
								callId: 's1',
								title: 'Find the invoices',
								task,
								entries: [{kind: 'person', text: 'Search the mailbox for October invoices.'}],
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
		expect(sub).toMatchObject({
			parentThreadId: thread.id,
			parentCallId: 's1',
			title: 'Find the invoices',
			userId,
			state: {kind: 'working'},
		});
		expect(sub.taskId).not.toBeNull();
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'tool_result',
			callId: 's1',
			text: `Started, id ${sub.id}.`,
		});
		expect(unwrap(await listEntries(sub.id)).map((entry) => [entry.kind, entry.text])).toEqual([
			['person', 'Search the mailbox for October invoices.'],
		]);
		expect(await db.agentTask.findUniqueOrThrow({where: {id: sub.taskId ?? ''}})).toMatchObject({
			...task,
			finishedAt: null,
		});

		// The sub-agent's first turn: a message to its parent, sent at once, and a sleep.
		const first = unwrap(await claimJob('worker-g', 60_000));
		if (!first || first.threadId !== sub.id) {
			throw new Error(`expected the sub-agent’s turn, got ${JSON.stringify(first)}`);
		}
		const later = new Date(Date.now() + 60 * 60 * 1000);
		unwrap(
			await completeInference(
				first.id,
				'worker-g',
				sub.id,
				{
					text: '',
					toolCalls: [
						{id: 'p1', name: 'send_to_parent', arguments: '{"text":"Which mailbox?"}'},
						{id: 'z1', name: 'sleep_until', arguments: '{"seconds":3600}'},
					],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
				},
				{
					plans: {
						p1: {
							kind: 'send_to_parent',
							message: {text: 'Which mailbox?', isError: false},
							sent: 'Sent.',
						},
						z1: {kind: 'job', runAt: later},
					},
				},
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			callId: 's1',
			text: 'Which mailbox?',
			isError: false,
			jobId: first.id,
		});
		expect(
			unwrap(await listEntries(sub.id)).map((entry) => [entry.kind, entry.callId, entry.text]),
		).toEqual([
			['person', null, 'Search the mailbox for October invoices.'],
			['assistant', null, ''],
			['tool_result', 'p1', 'Sent.'],
		]);
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({
			kind: 'asleep',
			until: later,
		});

		// The parent answers: a message to no such sub-agent, and one to its sub-agent, sent at once, which
		// wakes the sub-agent from its sleep: the sleep's job is due now, and the message waits for its answer.
		const answer = unwrap(await claimJob('worker-h', 60_000));
		if (!answer || answer.threadId !== thread.id || answer.kind !== 'inference') {
			throw new Error(`expected the parent’s turn, got ${JSON.stringify(answer)}`);
		}
		const sent = (subAgent: SubAgentRow | null) =>
			subAgent
				? {text: `Sent; it was ${subAgent.state.kind}.`, isError: false}
				: {text: 'No such sub-agent.', isError: true};
		unwrap(
			await completeInference(
				answer.id,
				'worker-h',
				thread.id,
				parentTurn([
					{id: 'm0', name: 'send_to_subagent', arguments: '{}'},
					{id: 'm1', name: 'send_to_subagent', arguments: '{}'},
				]),
				{
					plans: {
						m0: {
							kind: 'send_to_subagent',
							subAgentId: 'no-such-thread',
							entry: say('Hello?'),
							sent,
						},
						m1: {kind: 'send_to_subagent', subAgentId: sub.id, entry: say('The shared one.'), sent},
					},
				},
				readyForInference,
			),
		);
		expect(
			unwrap(await listEntries(thread.id))
				.slice(-2)
				.map((entry) => [entry.callId, entry.text, entry.isError]),
		).toEqual([
			['m0', 'No such sub-agent.', true],
			['m1', 'Sent; it was asleep.', false],
		]);
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'working'});
		expect(unwrap(await listEntries(sub.id))).toHaveLength(3);

		// The sleep answers as any wake-up does, and the message follows it; the parent's turn, woken by
		// the answers, ends.
		const woken = await claimBoth('worker-i', sub.id);
		if (woken.sub.kind !== 'tool' || woken.sub.callId !== 'z1') {
			throw new Error(`expected the sleep’s job, got ${JSON.stringify(woken.sub)}`);
		}
		unwrap(
			await completeToolJob(
				woken.sub.id,
				'worker-i',
				sub.id,
				{callId: 'z1', text: 'Woken.', isError: false},
				readyForInference,
			),
		);
		await endParentTurn(woken.parent, 'worker-i');
		expect(
			unwrap(await listEntries(sub.id))
				.slice(3)
				.map((entry) => [entry.kind, entry.callId, entry.text]),
		).toEqual([
			['tool_result', 'z1', 'Woken.'],
			['person', null, 'The shared one.'],
		]);

		// While the sub-agent's turn runs, the person speaks and the parent sends it more: the message waits.
		const next = unwrap(await claimJob('worker-j', 60_000));
		if (!next || next.threadId !== sub.id || next.kind !== 'inference') {
			throw new Error(`expected the sub-agent’s turn, got ${JSON.stringify(next)}`);
		}
		unwrap(await appendPersonMessage(thread.id, 'Also September', readyForInference));
		const relay = unwrap(await claimJob('worker-k', 60_000));
		if (!relay || relay.threadId !== thread.id) {
			throw new Error(`expected the parent’s turn, got ${JSON.stringify(relay)}`);
		}
		unwrap(
			await completeInference(
				relay.id,
				'worker-k',
				thread.id,
				parentTurn([{id: 'm2', name: 'send_to_subagent', arguments: '{}'}]),
				{
					plans: {
						m2: {
							kind: 'send_to_subagent',
							subAgentId: sub.id,
							entry: say('Any from September?'),
							sent,
						},
					},
				},
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			callId: 'm2',
			text: 'Sent; it was working.',
		});

		// The sub-agent answers without calls: a message came meanwhile, so it goes on to read it, its task
		// under way, and the parent is told what it said, going on.
		unwrap(
			await completeInference(
				next.id,
				'worker-j',
				sub.id,
				subTurn('Three invoices from Dana.'),
				{stop: stop('Three invoices from Dana.')},
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			callId: 's1',
			text: 'Three invoices from Dana.',
		});
		expect(unwrap(await listEntries(sub.id)).at(-1)).toMatchObject({
			kind: 'person',
			text: 'Any from September?',
		});
		expect(await taskOf(sub)).toMatchObject({finishedAt: null, outcome: null});

		// It answers again with nothing come meanwhile: it stops, its task finished with the outcome, and
		// the parent is told, with the note that it stopped.
		const goingOn = await claimBoth('worker-l', sub.id);
		await endParentTurn(goingOn.parent, 'worker-l');
		unwrap(
			await completeInference(
				goingOn.sub.id,
				'worker-l',
				sub.id,
				subTurn('Two from September.'),
				{stop: stop('Two from September.')},
				readyForInference,
			),
		);
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'stopped'});
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			callId: 's1',
			text: 'Two from September. (Stopped.)',
			isError: false,
		});
		expect(await taskOf(sub)).toMatchObject({
			outcome: 'Two from September.',
			finishedAt: expect.any(Date),
		});

		// A stopped sub-agent takes a message up: its thread is woken, and its task is under way again.
		const followUp = unwrap(await claimJob('worker-m', 60_000));
		if (!followUp || followUp.threadId !== thread.id) {
			throw new Error(`expected the parent’s turn, got ${JSON.stringify(followUp)}`);
		}
		unwrap(
			await completeInference(
				followUp.id,
				'worker-m',
				thread.id,
				parentTurn([{id: 'm3', name: 'send_to_subagent', arguments: '{}'}]),
				{
					plans: {
						m3: {
							kind: 'send_to_subagent',
							subAgentId: sub.id,
							entry: say('Any from August?'),
							sent,
						},
					},
				},
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			callId: 'm3',
			text: 'Sent; it was stopped.',
		});
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'working'});
		expect(await taskOf(sub)).toMatchObject({finishedAt: null, outcome: null});

		// A sub-agent whose turn failed stops with the failure, which reaches its parent as an error.
		const failing = await claimBoth('worker-n', sub.id);
		await endParentTurn(failing.parent, 'worker-n');
		unwrap(
			await failJob(
				failing.sub.id,
				'worker-n',
				'boom',
				() => ({kind: 'stop', stop: stop('The sub-agent failed: boom', true)}),
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			callId: 's1',
			text: 'The sub-agent failed: boom (Stopped.)',
			isError: true,
		});
		// Its log has the failure as its answer, so it is not run again until a message comes.
		expect(unwrap(await listEntries(sub.id)).at(-1)).toMatchObject({
			kind: 'assistant',
			text: 'The sub-agent failed: boom',
			isError: true,
		});
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'stopped'});
		expect(await taskOf(sub)).toMatchObject({
			outcome: 'The sub-agent failed: boom',
			finishedAt: expect.any(Date),
		});

		// A job that is no longer the worker's writes nothing.
		expect(
			unwrap(
				await completeInference(
					failing.sub.id,
					'worker-n',
					sub.id,
					subTurn('Late.'),
					{stop: stop('Late.')},
					readyForInference,
				),
			),
		).toBe(false);
	});
});
