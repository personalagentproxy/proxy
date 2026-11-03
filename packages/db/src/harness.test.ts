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
	listSubAgents,
	requeueJob,
	sendToSubAgent,
	type ThreadRow,
} from './harness';

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

	test('a sub-agent is started as the answer is written, with its task and brief; stops with what it said, which reaches its parent; and is taken up again by a message', async () => {
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

		// The parent answers: its turn, then a message to the sub-agent, which cuts the sleep short.
		const answer = unwrap(await claimJob('worker-h', 60_000));
		if (!answer || answer.threadId !== thread.id || answer.kind !== 'inference') {
			throw new Error(`expected the parent’s turn, got ${JSON.stringify(answer)}`);
		}
		unwrap(
			await completeInference(
				answer.id,
				'worker-h',
				thread.id,
				{
					text: '',
					toolCalls: [{id: 'm1', name: 'send_to_subagent', arguments: '{}'}],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
				},
				{plans: {m1: {kind: 'job', runAt: new Date()}}},
				readyForInference,
			),
		);
		const send = unwrap(await claimJob('worker-i', 60_000));
		if (!send || send.kind !== 'tool' || send.callId !== 'm1') {
			throw new Error(`expected the message’s job, got ${JSON.stringify(send)}`);
		}
		const message = {
			entry: {kind: 'person' as const, text: 'The shared one.'},
			wokenEarly: 'Woken early.',
		};
		expect(
			unwrap(
				await sendToSubAgent(
					send.id,
					'worker-i',
					thread,
					'no-such-thread',
					message,
					readyForInference,
				),
			),
		).toBeNull();
		expect(
			unwrap(await sendToSubAgent(send.id, 'worker-i', thread, sub.id, message, readyForInference)),
		).toMatchObject({id: sub.id, state: {kind: 'asleep'}});
		unwrap(
			await completeToolJob(
				send.id,
				'worker-i',
				thread.id,
				{callId: 'm1', text: 'Sent.', isError: false},
				readyForInference,
			),
		);
		expect(
			unwrap(await listEntries(sub.id))
				.slice(3)
				.map((entry) => [entry.kind, entry.callId, entry.text]),
		).toEqual([
			['tool_result', 'z1', 'Woken early.'],
			['person', null, 'The shared one.'],
		]);
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'working'});

		// The sub-agent's next turn stops it: its task is finished with the outcome, and the parent told what it said.
		const next = unwrap(await claimJob('worker-j', 60_000));
		if (!next || next.threadId !== sub.id || next.kind !== 'inference') {
			throw new Error(`expected the sub-agent’s turn, got ${JSON.stringify(next)}`);
		}
		unwrap(
			await completeInference(
				next.id,
				'worker-j',
				sub.id,
				{
					text: 'Three invoices from Dana.',
					toolCalls: [],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
				},
				{
					stop: {
						outcome: 'Three invoices from Dana.',
						said: {text: 'Three invoices from Dana. (Stopped.)', isError: false},
					},
				},
				readyForInference,
			),
		);
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'stopped'});
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			callId: 's1',
			text: 'Three invoices from Dana. (Stopped.)',
			isError: false,
		});
		expect(await db.agentTask.findUniqueOrThrow({where: {id: sub.taskId ?? ''}})).toMatchObject({
			outcome: 'Three invoices from Dana.',
			finishedAt: expect.any(Date),
		});

		// A stopped sub-agent takes a message up: its thread is woken, nothing else.
		const again = unwrap(await claimJob('worker-k', 60_000));
		if (!again || again.threadId !== thread.id) {
			throw new Error(`expected the parent’s turn, got ${JSON.stringify(again)}`);
		}
		unwrap(
			await completeInference(
				again.id,
				'worker-k',
				thread.id,
				{
					text: '',
					toolCalls: [{id: 'm2', name: 'send_to_subagent', arguments: '{}'}],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
				},
				{plans: {m2: {kind: 'job', runAt: new Date()}}},
				readyForInference,
			),
		);
		const send2 = unwrap(await claimJob('worker-l', 60_000));
		if (!send2 || send2.callId !== 'm2') {
			throw new Error(`expected the message’s job, got ${JSON.stringify(send2)}`);
		}
		const followUp = {
			entry: {kind: 'person' as const, text: 'Any from September?'},
			wokenEarly: 'Woken early.',
		};
		expect(
			unwrap(
				await sendToSubAgent(send2.id, 'worker-l', thread, sub.id, followUp, readyForInference),
			),
		).toMatchObject({state: {kind: 'stopped'}});
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'working'});
		expect(unwrap(await listEntries(sub.id)).at(-1)).toMatchObject({
			kind: 'person',
			text: 'Any from September?',
		});
		unwrap(
			await completeToolJob(
				send2.id,
				'worker-l',
				thread.id,
				{callId: 'm2', text: 'Sent.', isError: false},
				readyForInference,
			),
		);

		// A sub-agent whose turn failed stops with the failure, which reaches its parent as an error.
		const failing = unwrap(await claimJob('worker-m', 60_000));
		if (!failing || failing.threadId !== sub.id) {
			throw new Error(`expected the sub-agent’s turn, got ${JSON.stringify(failing)}`);
		}
		unwrap(
			await failJob(
				failing.id,
				'worker-m',
				'boom',
				() => ({
					kind: 'stop',
					stop: {
						outcome: 'The sub-agent failed: boom',
						said: {text: 'The sub-agent failed: boom', isError: true},
					},
				}),
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			callId: 's1',
			text: 'The sub-agent failed: boom',
			isError: true,
		});
		expect(unwrap(await listSubAgents(thread.id))[0]?.state).toEqual({kind: 'stopped'});

		// A job that is no longer the worker's sends nothing.
		expect(
			unwrap(
				await sendToSubAgent(send2.id, 'worker-l', thread, sub.id, followUp, readyForInference),
			),
		).toBe(false);
	});
});
