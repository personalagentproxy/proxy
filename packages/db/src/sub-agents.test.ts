import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	type AfterAnswer,
	claimJob,
	type ClaimedJob,
	completeInference,
	ensureFirstPersona,
	ensureMemberChat,
	failJob,
	getJobThread,
	listChatThreads,
	listEntries,
	listSubAgents,
	openThread,
	type SubAgentStart,
	tellParentInline,
	type ThreadEnd,
	type ThreadRow,
} from './harness';

// A thread's sub-agents, against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/sub-agents.test.ts` from this package;
// skipped without DATABASE_URL. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

// The end of a turn that says `text`, as the api composes it (thread-rules.ts threadEnd).
function end(text: string, isError = false): ThreadEnd {
	return {
		outcome: text,
		toParent: {stopped: {text: `${text} (stopped)`, isError}, goingOn: {text, isError}},
	};
}

function said(text: string, toolCalls: Array<{id: string; name: string; arguments: string}> = []) {
	return {text, toolCalls, inputTokens: 1, outputTokens: 1, system: null};
}

describe.skipIf(!databaseUrl)('sub-agents, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let chat: ThreadRow;
	let thread: ThreadRow;
	let subAgentId = '';

	// Every job due now, each claimed by `workerId`, by the thread it is of.
	async function claimDue(workerId: string): Promise<Map<string, ClaimedJob>> {
		const claimed = new Map<string, ClaimedJob>();
		for (;;) {
			const job = unwrap(await claimJob(workerId, 60_000));
			if (!job) {
				return claimed;
			}
			claimed.set(job.threadId, job);
		}
	}

	function start(callId: string): SubAgentStart {
		return {
			callId,
			title: 'Read the contract',
			task: {
				orgId,
				agentId,
				ownerUserId: userId,
				personaId: chat.personaId,
				parentId: null,
				title: 'Read the contract',
				goal: 'Find the notice period.',
				via: 'harness',
			},
			entries: [{kind: 'person', text: 'Find the notice period.'}],
		};
	}

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `sub-agents-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Sub-agents test', slug: `sub-agents-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		const agent = await db.agent.create({
			data: {
				orgId,
				providerId: 'built-in',
				name: 'Built in',
				username: `sub-agents-test-${stamp}`,
				passwordHash: '',
			},
		});
		agentId = agent.id;
		const persona = unwrap(await ensureFirstPersona(orgId));
		chat = unwrap(await ensureMemberChat({orgId, agentId, personaId: persona.id, userId}));
		const task = {
			orgId,
			agentId,
			ownerUserId: userId,
			personaId: persona.id,
			parentId: null,
			title: 'Contract',
			goal: 'Check the contract',
			via: 'harness' as const,
		};
		const opened = unwrap(
			await openThread(chat.id, 'Check the contract', {title: 'Contract', task}, readyForInference),
		);
		if (!opened) {
			throw new Error('no chat');
		}
		thread = opened.thread;
	});

	afterAll(async () => {
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
		}
		await db.user.deleteMany({where: {id: userId}});
	});

	test('a thread’s call starts one: a thread of the same chat, which the chat doesn’t list, with its own task, woken by its brief', async () => {
		const jobs = await claimDue('w1');
		const job = jobs.get(thread.id);
		if (!job) {
			throw new Error('the thread was not woken');
		}
		const call = {id: 'c1', name: 'create_subagent', arguments: '{}'};
		const after: AfterAnswer = {
			plans: {c1: {kind: 'create_subagent', start: start('c1'), started: (id) => `Started ${id}.`}},
		};
		expect(
			unwrap(
				await completeInference(
					job.id,
					'w1',
					thread.id,
					said('Reading it.', [call]),
					after,
					readyForInference,
				),
			),
		).toBe(true);

		const entries = unwrap(await listEntries(thread.id));
		const result = entries.find((entry) => entry.kind === 'tool_result' && entry.callId === 'c1');
		subAgentId = result?.text.replace(/^Started (.*)\.$/, '$1') ?? '';
		const sub = unwrap(await getJobThread(subAgentId));
		expect(sub).toMatchObject({
			parentThreadId: chat.id,
			subAgentOfId: thread.id,
			parentCallId: 'c1',
			title: 'Read the contract',
		});
		expect(sub?.taskId).not.toBe(thread.taskId);
		expect(unwrap(await listEntries(subAgentId)).map((entry) => [entry.kind, entry.text])).toEqual([
			['person', 'Find the notice period.'],
		]);
		expect(unwrap(await listChatThreads(chat.id, [])).map((listed) => listed.id)).toEqual([
			thread.id,
		]);
		expect(
			unwrap(await listSubAgents(thread.id)).map((listed) => [listed.id, listed.state.kind]),
		).toEqual([[subAgentId, 'working']]);
	});

	test('what it says as its turn ends lands in the thread as an event on the call that started it, which wakes the thread, and its task is finished', async () => {
		const jobs = await claimDue('w1');
		const parentJob = jobs.get(thread.id);
		const subJob = jobs.get(subAgentId);
		if (!parentJob || !subJob) {
			throw new Error(`expected both to be at work, got ${[...jobs.keys()].join(', ')}`);
		}
		// The thread answers first, telling the person it is looking, which ends its turn.
		expect(
			unwrap(
				await completeInference(
					parentJob.id,
					'w1',
					thread.id,
					said('Looking into it.'),
					{end: end('Looking into it.')},
					readyForInference,
				),
			),
		).toBe(true);
		expect(
			unwrap(
				await completeInference(
					subJob.id,
					'w1',
					subAgentId,
					said('Notice is 90 days.'),
					{end: end('Notice is 90 days.')},
					readyForInference,
				),
			),
		).toBe(true);

		const told = unwrap(await listEntries(thread.id)).at(-1);
		expect(told).toMatchObject({kind: 'event', callId: 'c1'});
		expect(told?.text).toContain('Notice is 90 days. (stopped)');
		expect(told?.text).toContain(subAgentId);
		const subTask = await db.agentTask.findUniqueOrThrow({
			where: {id: unwrap(await getJobThread(subAgentId))?.taskId ?? ''},
		});
		expect(subTask).toMatchObject({outcome: 'Notice is 90 days.'});
		expect(subTask.finishedAt).not.toBeNull();
		expect(unwrap(await listSubAgents(thread.id)).map((listed) => listed.state.kind)).toEqual([
			'stopped',
		]);
		expect([...(await claimDue('w1')).keys()]).toEqual([thread.id]);
	});

	test('the thread messages it, which takes it up again, answered with what it was up to', async () => {
		const job = await db.agentJob.findFirstOrThrow({
			where: {threadId: thread.id, status: 'running'},
		});
		const call = {id: 'c2', name: 'send_to_subagent', arguments: '{}'};
		const after: AfterAnswer = {
			plans: {
				c2: {
					kind: 'send_to_subagent',
					subAgentId,
					entry: {kind: 'person', text: 'And the renewal date?'},
					sent: (subAgent) => ({
						text: subAgent ? subAgent.state.kind : 'none',
						isError: subAgent === null,
					}),
				},
			},
		};
		expect(
			unwrap(
				await completeInference(
					job.id,
					'w1',
					thread.id,
					said('', [call]),
					after,
					readyForInference,
				),
			),
		).toBe(true);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'tool_result',
			callId: 'c2',
			text: 'stopped',
			isError: false,
		});
		expect(unwrap(await listEntries(subAgentId)).at(-1)).toMatchObject({
			kind: 'person',
			text: 'And the renewal date?',
		});
		const subTask = await db.agentTask.findUniqueOrThrow({
			where: {id: unwrap(await getJobThread(subAgentId))?.taskId ?? ''},
		});
		expect(subTask.finishedAt).toBeNull();
	});

	test('it tells the thread something as it goes, mid-turn, and a turn of its that failed tells the thread so, held while the thread is at work', async () => {
		const jobs = await claimDue('w2');
		const subJob = jobs.get(subAgentId);
		const parentJob = jobs.get(thread.id);
		if (!subJob || !parentJob) {
			throw new Error('expected both to be at work');
		}
		expect(
			unwrap(
				await tellParentInline(
					{jobId: subJob.id, workerId: 'w2', threadId: subAgentId},
					{text: 'Halfway.', isError: false},
					readyForInference,
				),
			),
		).toBe(true);
		const note = {kind: 'end' as const, text: 'Failed.', end: end('Failed.', true)};
		expect(unwrap(await failJob(subJob.id, 'w2', 'boom', () => note, readyForInference))).toBe(
			true,
		);

		// The thread is at work: what came waits until its turn is written.
		const held = await db.agentEntry.findMany({
			where: {threadId: thread.id, pending: true},
			orderBy: {seq: 'asc'},
		});
		expect(held.map((entry) => [entry.kind, entry.callId])).toEqual([
			['event', 'c1'],
			['event', 'c1'],
		]);
		expect(held[0]?.text).toContain('Halfway.');
		expect(held[1]?.text).toContain('which failed');
		expect(held[1]?.text).toContain('Failed. (stopped)');

		expect(
			unwrap(
				await completeInference(
					parentJob.id,
					'w2',
					thread.id,
					said('Still reading.'),
					{end: end('Still reading.')},
					readyForInference,
				),
			),
		).toBe(true);
		expect(await db.agentEntry.count({where: {threadId: thread.id, pending: true}})).toBe(0);
		expect(
			unwrap(await listEntries(thread.id))
				.slice(-2)
				.map((entry) => entry.kind),
		).toEqual(['event', 'event']);
	});

	test('a thread that is no sub-agent tells nobody as its turn ends', async () => {
		const jobs = await claimDue('w3');
		const job = jobs.get(thread.id);
		if (!job) {
			throw new Error('the thread was not woken');
		}
		const before = await db.agentEntry.count({
			where: {threadId: {not: thread.id}, thread: {orgId}},
		});
		expect(
			unwrap(
				await completeInference(
					job.id,
					'w3',
					thread.id,
					said('Notice is 90 days; renewal is in March.'),
					{end: end('Notice is 90 days; renewal is in March.')},
					readyForInference,
				),
			),
		).toBe(true);
		expect(await db.agentEntry.count({where: {threadId: {not: thread.id}, thread: {orgId}}})).toBe(
			before,
		);
	});
});
