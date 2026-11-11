import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {DEFAULT_LOOK, readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	addDraftAttachment,
	appendPersonMessage,
	appendSummary,
	appendTurnEntries,
	claimJob,
	completeInference,
	completeToolJob,
	createPersona,
	ensureFirstPersona,
	ensureMemberThread,
	failJob,
	finishJob,
	getPersona,
	isAttachedForTask,
	getThreadDraft,
	listEntries,
	listJobEvents,
	listShownEntries,
	listShownSubAgentEntries,
	messageSubAgentDirectly,
	listPinnedTasks,
	setTaskPinned,
	listOpenJobs,
	listAnswers,
	listAttachments,
	listDraftAttachments,
	listPersonas,
	listSubAgents,
	markThreadRead,
	removeDraftAttachment,
	requeueJob,
	saveThreadDraft,
	type JobRow,
	type NewEntry,
	type SubAgentRow,
	type SubAgentStop,
	type ThreadRow,
} from './harness';
import {removeMembership} from './organization';
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

	test('the personas are listed the one last active first: the last thing said in it, or its making before anything was', async () => {
		const general = unwrap(await ensureFirstPersona(orgId));
		const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
		const travel = unwrap(
			await createPersona(orgId, userId, {name: 'Travel', look, color: 'teal'}),
		);
		const billing = unwrap(
			await createPersona(orgId, userId, {name: 'Billing', look, color: 'pink'}),
		);
		const listed = async () =>
			unwrap(await listPersonas(orgId, userId)).map((persona) => persona.id);

		expect(await listed()).toEqual([billing.id, travel.id, general.id]);

		const travelThread = unwrap(
			await ensureMemberThread({orgId, agentId, personaId: travel.id, userId}),
		);
		unwrap(
			await appendPersonMessage(travelThread.id, 'Book the train to Lyon.', readyForInference),
		);
		expect(await listed()).toEqual([travel.id, billing.id, general.id]);

		// The job the message woke is done with, so the tests after this claim only their own.
		const job = unwrap(await claimJob('worker-p', 60_000));
		if (job?.threadId !== travelThread.id) {
			throw new Error(`expected the travel thread's job, got ${JSON.stringify(job)}`);
		}
		unwrap(await finishJob(job.id, 'worker-p'));
	});

	test('a persona is its maker’s, which no other member lists or finds, where General is every member’s, and it goes when its maker leaves', async () => {
		const general = unwrap(await ensureFirstPersona(orgId));
		const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
		const other = await db.user.create({data: {email: `harness-test-other-${stamp}@example.test`}});
		await db.orgMember.create({data: {orgId, userId: other.id}});
		const own = unwrap(await createPersona(orgId, userId, {name: 'Reminders', look, color: 'red'}));
		const theirs = unwrap(
			await createPersona(orgId, other.id, {name: 'Errands', look, color: 'green'}),
		);

		expect(own).toMatchObject({ownerUserId: userId, createdById: userId});
		expect(general.ownerUserId).toBeNull();
		const listedBy = async (member: string) =>
			unwrap(await listPersonas(orgId, member)).map((persona) => persona.id);
		expect(await listedBy(userId)).toContain(own.id);
		expect(await listedBy(userId)).not.toContain(theirs.id);
		expect(await listedBy(other.id)).toEqual([theirs.id, general.id]);
		expect(unwrap(await getPersona(orgId, userId, own.id))?.id).toBe(own.id);
		expect(unwrap(await getPersona(orgId, other.id, own.id))).toBeNull();
		expect(unwrap(await getPersona(orgId, other.id, general.id))?.id).toBe(general.id);
		// General is the one every member sees, however many of their own there are.
		expect(unwrap(await ensureFirstPersona(orgId)).id).toBe(general.id);

		unwrap(await removeMembership({orgId, userId: other.id, sharedAgentPasswordHash: ''}));
		expect(await db.persona.findUnique({where: {id: theirs.id}})).toBeNull();
		expect(await db.persona.findUnique({where: {id: own.id}})).not.toBeNull();
		await db.user.delete({where: {id: other.id}});
	});

	test('a draft is kept until it is replaced, forgotten or sent, and listed with its persona', async () => {
		const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
		const drafts = unwrap(
			await createPersona(orgId, userId, {name: 'Drafts', look, color: 'teal'}),
		);
		const draftThread = unwrap(
			await ensureMemberThread({orgId, agentId, personaId: drafts.id, userId}),
		);
		const listedDraft = async () =>
			unwrap(await listPersonas(orgId, userId)).find((persona) => persona.id === drafts.id)?.draft;

		expect(unwrap(await getThreadDraft(draftThread.id))).toBeNull();
		expect(await listedDraft()).toBeNull();

		expect(unwrap(await saveThreadDraft(draftThread.id, 'Pricing review with'))).toBe(true);
		expect(unwrap(await saveThreadDraft(draftThread.id, 'Pricing review with Dana'))).toBe(true);
		expect(unwrap(await getThreadDraft(draftThread.id))).toBe('Pricing review with Dana');
		expect(await listedDraft()).toBe('Pricing review with Dana');

		expect(unwrap(await saveThreadDraft(draftThread.id, null))).toBe(true);
		expect(unwrap(await getThreadDraft(draftThread.id))).toBeNull();

		unwrap(await saveThreadDraft(draftThread.id, 'Move the pricing review'));
		unwrap(await appendPersonMessage(draftThread.id, 'Move the pricing review', readyForInference));
		expect(unwrap(await getThreadDraft(draftThread.id))).toBeNull();
		expect(unwrap(await saveThreadDraft('no-such-thread', 'Hello'))).toBe(false);

		// The job the message woke is done with, so the tests after this claim only their own.
		const job = unwrap(await claimJob('worker-dr', 60_000));
		if (job?.threadId !== draftThread.id) {
			throw new Error(`expected the drafts thread's job, got ${JSON.stringify(job)}`);
		}
		unwrap(await finishJob(job.id, 'worker-dr'));
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

		// One that stopped more than 20 minutes ago keeps its task finished as it was, and takes a
		// message up with a new task for the same work.
		const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		await db.agentTask.update({
			where: {id: sub.taskId ?? ''},
			data: {finishedAt: anHourAgo, lastActiveAt: anHourAgo},
		});
		const longAfter = unwrap(await claimJob('worker-o', 60_000));
		if (!longAfter || longAfter.threadId !== thread.id) {
			throw new Error(`expected the parent’s turn, got ${JSON.stringify(longAfter)}`);
		}
		unwrap(
			await completeInference(
				longAfter.id,
				'worker-o',
				thread.id,
				parentTurn([{id: 'm4', name: 'send_to_subagent', arguments: '{}'}]),
				{
					plans: {
						m4: {kind: 'send_to_subagent', subAgentId: sub.id, entry: say('Any from July?'), sent},
					},
				},
				readyForInference,
			),
		);
		const [renewed] = unwrap(await listSubAgents(thread.id));
		if (!renewed) {
			throw new Error('expected the sub-agent');
		}
		expect(renewed.state).toEqual({kind: 'working'});
		expect(renewed.taskId).not.toBe(sub.taskId);
		expect(await taskOf(sub)).toMatchObject({
			outcome: 'The sub-agent failed: boom',
			finishedAt: anHourAgo,
		});
		expect(await taskOf(renewed)).toMatchObject({...task, finishedAt: null, outcome: null});
	});
	test('what the person attaches lands with what they said, in order, and is the conversation’s sub-agents’ to read: that version, of that file, for their task alone', async () => {
		const file = {
			connectionId: 'drive-1',
			fileId: 'file-1',
			version: 'v1',
			name: 'pricing.md',
			type: 'text/markdown',
			size: 42,
			text: '# Pricing',
			cut: false,
		};
		const picture = {...file, fileId: 'file-2', name: 'chart.png', type: 'image/png', text: null};

		const said = unwrap(
			await appendPersonMessage(thread.id, 'What do these say?', readyForInference, [
				file,
				picture,
			]),
		);
		unwrap(await appendPersonMessage(thread.id, 'And nothing with this one.', readyForInference));

		expect(unwrap(await listAttachments(thread.id))).toEqual([
			{...file, entryId: said?.id ?? ''},
			{...picture, entryId: said?.id ?? ''},
		]);

		const task = await db.agentTask.create({
			data: {orgId, agentId, title: 'Read the files', goal: 'Read', via: 'harness'},
		});
		const other = await db.agentTask.create({
			data: {orgId, agentId, title: 'Something else', goal: 'Else', via: 'harness'},
		});
		await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: thread.personaId,
				userId,
				parentThreadId: thread.id,
				parentCallId: 'c-attached',
				title: 'Read the files',
				taskId: task.id,
			},
		});
		const attached = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1'};

		expect(unwrap(await isAttachedForTask({orgId, taskId: task.id}, attached))).toBe(true);
		expect(
			unwrap(await isAttachedForTask({orgId, taskId: task.id}, {...attached, version: 'v2'})),
		).toBe(false);
		expect(
			unwrap(
				await isAttachedForTask({orgId, taskId: task.id}, {...attached, connectionId: 'drive-2'}),
			),
		).toBe(false);
		// A task that is no sub-agent's of the conversation, and one of another organization.
		expect(unwrap(await isAttachedForTask({orgId, taskId: other.id}, attached))).toBe(false);
		expect(unwrap(await isAttachedForTask({orgId: 'another-org', taskId: task.id}, attached))).toBe(
			false,
		);
	});
	test('the files an answer shows land with it, whether written as the turn goes or as it ends, and hand nothing over to sub-agents', async () => {
		const own = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: thread.personaId,
				userId,
				parentThreadId: thread.id,
				parentCallId: 'c-shown',
				title: 'Chart it',
			},
		});
		const job = await db.agentJob.create({
			data: {
				threadId: own.id,
				kind: 'inference',
				status: 'running',
				claimedBy: 'worker-shown',
				leaseExpiresAt: new Date(Date.now() + 60_000),
			},
		});
		const chart = {
			connectionId: 'drive-1',
			fileId: 'file-9',
			version: 'v1',
			name: 'chart.png',
			type: 'image/png',
			size: 42,
			text: null,
			cut: false,
		};
		const sheet = {...chart, fileId: 'file-10', name: 'q3.csv', type: 'text/csv'};

		unwrap(
			await appendTurnEntries(job.id, 'worker-shown', own.id, [
				{
					kind: 'assistant',
					text: 'Made ![Chart](link)',
					toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}],
					attachments: [chart],
				},
				{kind: 'tool_result', callId: 'c1', text: 'one', isError: false},
			]),
		);
		unwrap(
			await completeInference(
				job.id,
				'worker-shown',
				own.id,
				{
					text: 'Both: ![Chart](link) ![Sheet](link)',
					toolCalls: [],
					inputTokens: 1,
					outputTokens: 1,
					system: null,
					attachments: [chart, sheet],
				},
				{plans: {}},
				readyForInference,
			),
		);

		const answers = unwrap(await listEntries(own.id)).filter((entry) => entry.kind === 'assistant');
		expect(unwrap(await listAttachments(own.id))).toEqual([
			{...chart, entryId: answers[0]?.id ?? ''},
			{...chart, entryId: answers[1]?.id ?? ''},
			{...sheet, entryId: answers[1]?.id ?? ''},
		]);

		// What the agent showed lets no sub-agent read it as an attachment would.
		const task = await db.agentTask.create({
			data: {orgId, agentId, title: 'Chart task', goal: 'Chart', via: 'harness'},
		});
		await db.agentThread.update({where: {id: own.id}, data: {taskId: task.id}});
		expect(
			unwrap(
				await isAttachedForTask(
					{orgId, taskId: task.id},
					{connectionId: 'drive-1', fileId: 'file-9', version: 'v1'},
				),
			),
		).toBe(false);
	});
	test('the files put in a conversation’s input wait there in order, each once, up to as many as a message carries, are taken out one at a time, and go with the message that is sent', async () => {
		const file = (id: string, name: string) => ({
			connectionId: 'drive-1',
			fileId: id,
			version: 'v1',
			name,
			type: 'text/plain',
			size: 4,
		});
		const notes = file('file-1', 'notes.txt');
		const chart = file('file-2', 'chart.png');
		const logged = unwrap(await listAttachments(thread.id));

		expect(unwrap(await addDraftAttachment(thread.id, notes, 2))).toBe(true);
		expect(unwrap(await addDraftAttachment(thread.id, chart, 2))).toBe(true);
		// The same file at the same version is there once, and a full input takes no more.
		expect(unwrap(await addDraftAttachment(thread.id, notes, 2))).toBe(true);
		const full = await addDraftAttachment(thread.id, file('file-3', 'more.txt'), 2);
		expect(full.isErr() && full.error.kind).toBe('conflict');
		expect(unwrap(await listDraftAttachments(thread.id))).toEqual([notes, chart]);
		const listed = unwrap(await listPersonas(orgId, userId)).find(
			(persona) => persona.id === thread.personaId,
		);
		expect(listed?.draftAttachments).toEqual([notes, chart]);

		// A save of what was typed with the files' order keeps them as they sit among the words,
		// any it doesn't name after them, and adds or drops none.
		expect(
			unwrap(await saveThreadDraft(thread.id, 'See these', [chart, file('file-9', 'x')])),
		).toBe(true);
		expect(unwrap(await listDraftAttachments(thread.id))).toEqual([chart, notes]);
		expect(unwrap(await getThreadDraft(thread.id))).toBe('See these');
		expect(unwrap(await saveThreadDraft(thread.id, null, [notes]))).toBe(true);
		expect(unwrap(await listDraftAttachments(thread.id))).toEqual([notes, chart]);
		// A file named twice, as a chip copied in the input, keeps where it is named first.
		expect(unwrap(await saveThreadDraft(thread.id, null, [chart, notes, chart]))).toBe(true);
		expect(unwrap(await listDraftAttachments(thread.id))).toEqual([chart, notes]);
		expect(unwrap(await saveThreadDraft(thread.id, null, [notes]))).toBe(true);

		// What waits in the input is no part of the log, and lets no agent read it.
		expect(unwrap(await listAttachments(thread.id))).toEqual(logged);

		expect(unwrap(await removeDraftAttachment(thread.id, notes))).toBe(true);
		expect(unwrap(await listDraftAttachments(thread.id))).toEqual([chart]);
		// A later version of the file is another file to the input.
		expect(unwrap(await removeDraftAttachment(thread.id, {...chart, version: 'v2'}))).toBe(true);
		expect(unwrap(await listDraftAttachments(thread.id))).toEqual([chart]);

		const sent = {...chart, text: null, cut: false};
		const entry = unwrap(
			await appendPersonMessage(thread.id, 'Here it is.', readyForInference, [sent]),
		);
		expect(unwrap(await listDraftAttachments(thread.id))).toEqual([]);
		expect(unwrap(await listAttachments(thread.id))).toEqual([
			...logged,
			{...sent, entryId: entry?.id ?? ''},
		]);
		// A thread that isn't a conversation keeps none.
		expect(unwrap(await addDraftAttachment('no-such-thread', notes, 2))).toBe(false);
	});

	test('what the member writes in a sub-agent’s chat lands in its log as theirs, waking it, and in the conversation as a note, waking nothing; the chat shows it, and the sub-agent’s failures from the conversation', async () => {
		const persona = unwrap(
			await createPersona(orgId, userId, {name: 'Travel', look: DEFAULT_LOOK, color: 'teal'}),
		);
		const conversation = unwrap(
			await ensureMemberThread({orgId, agentId, personaId: persona.id, userId}),
		);
		await db.agentEntry.create({
			data: {threadId: conversation.id, kind: 'person', text: 'Find me flights'},
		});
		await db.agentEntry.create({
			data: {
				threadId: conversation.id,
				kind: 'assistant',
				text: '',
				toolCalls: JSON.stringify([
					{
						id: 'c1',
						name: 'create_subagent',
						arguments: '{"title":"Find flights","brief":"To Lisbon"}',
					},
				]),
			},
		});
		await db.agentEntry.create({
			data: {threadId: conversation.id, kind: 'tool_result', callId: 'c1', text: 'Started.'},
		});
		await db.agentEntry.create({
			data: {threadId: conversation.id, kind: 'assistant', text: 'On it.'},
		});
		const sub = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: persona.id,
				userId,
				parentThreadId: conversation.id,
				parentCallId: 'c1',
				title: 'Find flights',
			},
		});
		await db.agentEntry.create({data: {threadId: sub.id, kind: 'person', text: 'To Lisbon'}});
		await db.agentEntry.create({
			data: {threadId: sub.id, kind: 'assistant', text: 'Three direct flights.'},
		});

		expect(
			unwrap(
				await messageSubAgentDirectly(conversation.id, sub.id, 'Only mornings', readyForInference),
			),
		).toBe(true);

		expect(
			unwrap(await listEntries(sub.id)).map((entry) => [entry.kind, entry.direct, entry.text]),
		).toEqual([
			['person', false, 'To Lisbon'],
			['assistant', false, 'Three direct flights.'],
			['person', true, 'Only mornings'],
		]);
		expect(unwrap(await listEntries(conversation.id)).at(-1)).toMatchObject({
			kind: 'note',
			callId: 'c1',
			text: 'Only mornings',
		});
		// The sub-agent takes it up; the agent talking with the person sleeps on.
		const jobs = await db.agentJob.findMany({
			where: {threadId: {in: [conversation.id, sub.id]}, status: 'queued'},
			select: {threadId: true, kind: true},
		});
		expect(jobs).toEqual([{threadId: sub.id, kind: 'inference'}]);

		// The conversation shows no note, but the answer that started the sub-agent, which says nothing,
		// where its call is asked for; the chat shows the sub-agent's failure, which only the
		// conversation's log has, and none of what else it told the conversation.
		expect(
			unwrap(await listShownEntries(conversation.id, ['create_subagent'])).map(
				(entry) => entry.text,
			),
		).toEqual(['Find me flights', '', 'On it.']);
		expect(unwrap(await listShownEntries(conversation.id, [])).map((entry) => entry.text)).toEqual([
			'Find me flights',
			'On it.',
		]);
		await db.agentEntry.create({
			data: {
				threadId: conversation.id,
				kind: 'event',
				callId: 'c1',
				text: 'It failed.',
				isError: true,
			},
		});
		await db.agentEntry.create({
			data: {threadId: conversation.id, kind: 'event', callId: 'c1', text: 'Two found.'},
		});
		// An answer to it without a word ends the turn, which the conversation shows where it is.
		await db.agentEntry.create({data: {threadId: conversation.id, kind: 'assistant', text: ''}});
		expect(
			unwrap(await listShownEntries(conversation.id, [])).map((entry) => [entry.kind, entry.text]),
		).toEqual([
			['person', 'Find me flights'],
			['assistant', 'On it.'],
			['assistant', ''],
		]);
		const [subRow] = unwrap(await listSubAgents(conversation.id));
		if (!subRow) {
			throw new Error('expected the sub-agent');
		}
		expect(
			unwrap(await listShownSubAgentEntries(subRow, ['send_to_parent'])).map((entry) => entry.text),
		).toEqual(['To Lisbon', 'Three direct flights.', 'Only mornings', 'It failed.']);

		// With files, kept with what the member wrote in the sub-agent's log, which its task may read,
		// and with the note in the conversation.
		const itinerary = {
			connectionId: 'drive-1',
			fileId: 'file-9',
			version: 'v1',
			name: 'itinerary.md',
			type: 'text/markdown',
			size: 12,
			text: '# Day one',
			cut: false,
		};
		expect(
			unwrap(
				await messageSubAgentDirectly(conversation.id, sub.id, 'Use this', readyForInference, [
					itinerary,
				]),
			),
		).toBe(true);
		const written = unwrap(await listEntries(sub.id)).at(-1);
		const noted = unwrap(await listEntries(conversation.id)).at(-1);
		expect(unwrap(await listAttachments(sub.id))).toEqual([
			{...itinerary, entryId: written?.id ?? ''},
		]);
		expect(unwrap(await listAttachments(conversation.id))).toEqual([
			{...itinerary, entryId: noted?.id ?? ''},
		]);
		await db.agentEntry.deleteMany({where: {id: {in: [written?.id ?? '', noted?.id ?? '']}}});

		// Only a sub-agent of the conversation, and only from the conversation.
		expect(
			unwrap(
				await messageSubAgentDirectly(conversation.id, 'no-such-thread', 'Hi', readyForInference),
			),
		).toBe(false);
		expect(unwrap(await messageSubAgentDirectly(thread.id, sub.id, 'Hi', readyForInference))).toBe(
			false,
		);
		expect(unwrap(await messageSubAgentDirectly(sub.id, sub.id, 'Hi', readyForInference))).toBe(
			false,
		);

		// Pinned, it is listed under its persona, the one with something said in it last first; only
		// a sub-agent of the conversation, and only the member's own.
		expect(unwrap(await listPinnedTasks(orgId, userId))).toEqual([]);
		const other = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: persona.id,
				userId,
				parentThreadId: conversation.id,
				parentCallId: 'c2',
				title: 'Check the calendar',
			},
		});
		await db.agentEntry.create({
			data: {
				threadId: other.id,
				kind: 'person',
				text: 'Next weekend',
				createdAt: new Date(Date.now() - 60 * 60 * 1000),
			},
		});
		expect(unwrap(await setTaskPinned(conversation.id, other.id, true))).toBe(true);
		expect(unwrap(await setTaskPinned(conversation.id, sub.id, true))).toBe(true);
		expect(unwrap(await setTaskPinned(thread.id, sub.id, true))).toBe(false);
		expect(unwrap(await setTaskPinned(conversation.id, conversation.id, true))).toBe(false);
		expect(
			unwrap(await listPinnedTasks(orgId, userId)).map(({id, personaId, title}) => ({
				id,
				personaId,
				title,
			})),
		).toEqual([
			{id: sub.id, personaId: persona.id, title: 'Find flights'},
			{id: other.id, personaId: persona.id, title: 'Check the calendar'},
		]);
		expect(unwrap(await listPinnedTasks(orgId, 'someone-else'))).toEqual([]);
		expect(unwrap(await setTaskPinned(conversation.id, sub.id, false))).toBe(true);
		expect(unwrap(await listPinnedTasks(orgId, userId)).map(({id}) => id)).toEqual([other.id]);

		await db.persona.delete({where: {id: persona.id}});
	});
});
