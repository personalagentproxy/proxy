import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {completeSetAlert, fireAlert, listMemberAlerts, listThreadAlerts} from './alerts';
import {
	appendEntry,
	appendTurnEntries,
	completeInference,
	createPersona,
	ensureMemberChat,
	failJob,
	getChatThread,
	hasChatThread,
	listAnswers,
	listChatThreads,
	listEntries,
	listPersonas,
	listThreadsWithoutSummary,
	lockThread,
	markChatRead,
	markThreadDone,
	openThread,
	replyInThread,
	saveChatDraft,
	writeThreadStanding,
	type JobRow,
	type ThreadOpening,
	type ThreadRow,
} from './harness';

// A chat's threads, against the local database, as harness.test.ts runs: with it up and the
// environment loaded, `bun --env-file=../../.env test src/chat-threads.test.ts` from this package;
// skipped without DATABASE_URL. Everything made here is one organization's, deleted at the end. The
// agent is woken as the api wakes it (@proxy/utils/harness readyForInference). A job is claimed
// here by its thread rather than as the worker claims the next one due, so that nothing another
// test left queued is taken.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

// A turn of the agent's that says `text`, with no calls.
function said(text: string) {
	return {text, toolCalls: [], inputTokens: 1, outputTokens: 1, system: null};
}

describe.skipIf(!databaseUrl)('a chat’s threads, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let chat: ThreadRow;

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `chat-threads-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Chat threads test', slug: `chat-threads-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		const agent = await db.agent.create({
			data: {
				orgId,
				providerId: 'built-in',
				name: 'Built in',
				username: `chat-threads-test-${stamp}`,
				passwordHash: '',
			},
		});
		agentId = agent.id;
		const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
		const persona = unwrap(
			await createPersona(orgId, userId, {name: 'Finance', look, color: 'teal'}),
		);
		chat = unwrap(await ensureMemberChat({orgId, agentId, personaId: persona.id, userId}));
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

	// A thread as the api opens one with `title`.
	function opening(title: string): ThreadOpening {
		return {
			title,
			task: {
				orgId,
				agentId,
				ownerUserId: userId,
				personaId: chat.personaId,
				parentId: null,
				title,
				goal: title,
				via: 'harness',
			},
		};
	}

	// Opens a thread with what the member says.
	async function open(text: string): Promise<ThreadRow> {
		const opened = unwrap(await openThread(chat.id, text, opening(text), readyForInference));
		if (!opened) {
			throw new Error('no chat');
		}
		return opened.thread;
	}

	// The thread's turn queued, claimed by `workerId`.
	async function claim(threadId: string, workerId: string): Promise<JobRow> {
		const queued = await db.agentJob.findFirstOrThrow({
			where: {threadId, kind: {in: ['inference', 'wake']}, status: 'queued'},
		});
		await db.agentJob.update({
			where: {id: queued.id},
			data: {status: 'running', claimedBy: workerId, attempts: {increment: 1}},
		});
		return {...queued, status: 'running', claimedBy: workerId, attempts: queued.attempts + 1};
	}

	// The thread's turns still to run or running.
	function openTurns(threadId: string) {
		return db.agentJob.count({
			where: {threadId, kind: {in: ['inference', 'wake']}, status: {in: ['queued', 'running']}},
		});
	}

	function taskOf(thread: ThreadRow) {
		return db.agentTask.findUniqueOrThrow({where: {id: thread.taskId ?? ''}});
	}

	test('a thread is opened under the chat with its task, the member’s message as its first entry with their files, which wakes it, and the chat’s draft goes with it', async () => {
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
		unwrap(await saveChatDraft(chat.id, 'Find the pricing review with Dana'));

		const opened = unwrap(
			await openThread(
				chat.id,
				'Find the pricing review with Dana',
				opening('Pricing review with Dana'),
				readyForInference,
				[file],
			),
		);
		if (!opened) {
			throw new Error('no chat');
		}
		const {thread, entry} = opened;

		expect(thread).toMatchObject({
			parentThreadId: chat.id,
			title: 'Pricing review with Dana',
			personaId: chat.personaId,
			userId,
		});
		expect(await taskOf(thread)).toMatchObject({
			title: 'Pricing review with Dana',
			ownerUserId: userId,
			personaId: chat.personaId,
			finishedAt: null,
		});
		expect(entry).toMatchObject({
			threadId: thread.id,
			kind: 'person',
			text: 'Find the pricing review with Dana',
			pending: false,
		});
		expect(await openTurns(thread.id)).toBe(1);
		expect((await db.agentThread.findUniqueOrThrow({where: {id: chat.id}})).draft).toBeNull();
		// Nothing lands in the chat itself, and nothing wakes it.
		expect(unwrap(await listEntries(chat.id))).toEqual([]);
		expect(await openTurns(chat.id)).toBe(0);
		// A chat runs no turns: what lands in it wakes nothing.
		const landed = await db.$transaction(async (tx) => {
			const locked = await lockThread(tx, chat.id);
			if (!locked) {
				throw new Error('no chat');
			}
			return appendEntry(tx, locked, {kind: 'person', text: 'Hello?'}, readyForInference);
		});
		expect(await openTurns(chat.id)).toBe(0);
		await db.agentEntry.delete({where: {id: landed.id}});

		const listed = unwrap(await getChatThread(chat.id, thread.id, []));
		expect(listed?.state).toEqual({kind: 'working'});
		expect(listed?.attachments).toEqual([{...file, entryId: entry.id, gone: true}]);
		// Each entry as a thread shows it, without what the model was sent for it.
		expect(Object.keys(listed?.entries[0] ?? {}).toSorted()).toEqual(
			['createdAt', 'id', 'isError', 'kind', 'pending', 'seq', 'text', 'toolCalls'].toSorted(),
		);

		// The chat's list has the files of what opened each thread, not of what was said after.
		const chart = {...file, fileId: 'file-2', name: 'chart.png', type: 'image/png'};
		const reply = unwrap(
			await replyInThread(chat.id, thread.id, 'And this chart?', readyForInference, [chart]),
		);
		const inList = unwrap(await listChatThreads(chat.id, [])).find((one) => one.id === thread.id);
		expect(inList?.entries.map((one) => one.id)).toEqual([entry.id, reply?.id ?? '']);
		expect(inList?.attachments).toEqual([{...file, entryId: entry.id, gone: true}]);
		expect(
			unwrap(await getChatThread(chat.id, thread.id, []))?.attachments.map((one) => one.name),
		).toEqual(['pricing.md', 'chart.png']);
		await db.agentEntry.delete({where: {id: reply?.id ?? ''}});

		// Whether the chat has a thread is asked without reading it.
		expect(unwrap(await hasChatThread(chat.id, thread.id))).toBe(true);
		expect(unwrap(await hasChatThread(chat.id, 'no-such-thread'))).toBe(false);
		expect(unwrap(await hasChatThread(thread.id, thread.id))).toBe(false);

		// Only a chat opens threads.
		expect(unwrap(await openThread(thread.id, 'Hi', opening('Hi'), readyForInference))).toBeNull();
		expect(
			unwrap(await openThread('no-such-chat', 'Hi', opening('Hi'), readyForInference)),
		).toBeNull();

		const job = await claim(thread.id, 'worker-open');
		unwrap(
			await completeInference(
				job.id,
				'worker-open',
				thread.id,
				said('Found it.'),
				{end: {outcome: 'Found it.'}},
				readyForInference,
			),
		);
	});

	test('an answer without calls ends the thread’s turn, its task finished with the outcome, telling the chat nothing; a reply that came meanwhile is read next', async () => {
		const thread = await open('List the invoices from Dana');
		const first = await claim(thread.id, 'worker-a');
		unwrap(
			await completeInference(
				first.id,
				'worker-a',
				thread.id,
				said('Three invoices.'),
				{end: {outcome: 'Three invoices.'}},
				readyForInference,
			),
		);

		expect(await taskOf(thread)).toMatchObject({outcome: 'Three invoices.'});
		expect((await taskOf(thread)).finishedAt).not.toBeNull();
		expect(await openTurns(thread.id)).toBe(0);
		expect(unwrap(await listEntries(chat.id))).toEqual([]);
		expect(await openTurns(chat.id)).toBe(0);

		// The member replies: the thread is taken up, its task under way again.
		unwrap(await replyInThread(chat.id, thread.id, 'And from before October?', readyForInference));
		expect((await taskOf(thread)).finishedAt).toBeNull();
		const second = await claim(thread.id, 'worker-b');
		// Another reply lands while it answers, pending, and is read next.
		const meanwhile = unwrap(
			await replyInThread(chat.id, thread.id, 'Only paid ones.', readyForInference),
		);
		expect(meanwhile?.pending).toBe(true);
		unwrap(
			await completeInference(
				second.id,
				'worker-b',
				thread.id,
				said('Two more.'),
				{end: {outcome: 'Two more.'}},
				readyForInference,
			),
		);

		expect((await taskOf(thread)).finishedAt).toBeNull();
		expect(unwrap(await listEntries(thread.id)).map((entry) => [entry.kind, entry.text])).toEqual([
			['person', 'List the invoices from Dana'],
			['assistant', 'Three invoices.'],
			['person', 'And from before October?'],
			['assistant', 'Two more.'],
			['person', 'Only paid ones.'],
		]);
		expect(await openTurns(thread.id)).toBe(1);
		const third = await claim(thread.id, 'worker-c');
		unwrap(
			await completeInference(
				third.id,
				'worker-c',
				thread.id,
				said('One is paid.'),
				{end: {outcome: 'One is paid.'}},
				readyForInference,
			),
		);
		expect(await taskOf(thread)).toMatchObject({outcome: 'One is paid.'});
	});

	test('a reply wakes a thread asleep now, and lands only in a thread of the member’s chat', async () => {
		const thread = await open('Check the invoices again in an hour');
		const job = await claim(thread.id, 'worker-s');
		const sleep = {id: 'c1', name: 'sleep_until', arguments: '{"seconds":3600}'};
		const wakeAt = new Date(Date.now() + 3_600_000);
		unwrap(
			await completeInference(
				job.id,
				'worker-s',
				thread.id,
				{...said(''), toolCalls: [sleep]},
				{plans: {c1: {kind: 'job', runAt: wakeAt}}},
				readyForInference,
			),
		);
		expect(unwrap(await getChatThread(chat.id, thread.id, []))?.state).toEqual({
			kind: 'asleep',
			until: wakeAt,
		});

		unwrap(await replyInThread(chat.id, thread.id, 'Check now instead.', readyForInference));
		const sleeping = await db.agentJob.findFirstOrThrow({
			where: {threadId: thread.id, kind: 'tool'},
		});
		expect(sleeping.runAt.getTime()).toBeLessThanOrEqual(Date.now());

		expect(
			unwrap(await replyInThread(chat.id, 'no-such-thread', 'Hi', readyForInference)),
		).toBeNull();
		expect(unwrap(await replyInThread(thread.id, thread.id, 'Hi', readyForInference))).toBeNull();
		await db.agentJob.updateMany({where: {threadId: thread.id}, data: {status: 'done'}});
	});

	test('a thread whose turn failed answers the member with the failure and ends its turn', async () => {
		const thread = await open('Summarize the pricing review');
		const job = await claim(thread.id, 'worker-f');
		const text =
			'Something went wrong on my side, so I could not answer: boom. Say something to try again.';
		unwrap(
			await failJob(
				job.id,
				'worker-f',
				'boom',
				() => ({kind: 'end', text, end: {outcome: text}}),
				readyForInference,
			),
		);

		expect(
			unwrap(await listEntries(thread.id)).map((entry) => [entry.kind, entry.text, entry.isError]),
		).toEqual([
			['person', 'Summarize the pricing review', false],
			['assistant', text, true],
		]);
		expect(await taskOf(thread)).toMatchObject({outcome: text});
		expect(await openTurns(thread.id)).toBe(0);
		expect(unwrap(await listEntries(chat.id))).toEqual([]);
	});

	test('a thread lists what the member sees of it: what they said, its events, the answers in words and those that made a call named, not the other calls or what they answered', async () => {
		const thread = await open('Move the pricing review to Friday');
		const job = await claim(thread.id, 'worker-l');
		const told = {
			id: 'c1',
			name: 'send_to_person',
			arguments: '{"text":"Looking at the calendar."}',
		};
		const script = {id: 'c2', name: 'script', arguments: '{"code":"return 1"}'};
		unwrap(
			await appendTurnEntries(job.id, 'worker-l', thread.id, [
				{kind: 'assistant', text: '', toolCalls: [told, script]},
				{kind: 'tool_result', callId: 'c1', text: 'Sent.', isError: false},
				{kind: 'tool_result', callId: 'c2', text: '1', isError: false},
			]),
		);
		unwrap(
			await completeInference(
				job.id,
				'worker-l',
				thread.id,
				said('Moved it to Friday.'),
				{end: {outcome: 'Moved it to Friday.'}},
				readyForInference,
			),
		);

		const listed = unwrap(await getChatThread(chat.id, thread.id, ['send_to_person']));
		expect(listed?.state).toEqual({kind: 'stopped'});
		expect(listed?.entries.map((entry) => [entry.kind, entry.text])).toEqual([
			['person', 'Move the pricing review to Friday'],
			['assistant', ''],
			['assistant', 'Moved it to Friday.'],
		]);
		expect(unwrap(await getChatThread(chat.id, thread.id, []))?.entries).toHaveLength(2);
		expect(unwrap(await getChatThread(chat.id, 'no-such-thread', []))).toBeNull();
		expect(unwrap(await listChatThreads(chat.id, [])).map((one) => one.id)).toContain(thread.id);
	});

	test('the chat’s last message, its last answer and its read marker take its threads in', async () => {
		const persona = chat.personaId;
		const lastMessage = async () =>
			unwrap(await listPersonas(orgId, userId)).find((one) => one.id === persona)?.lastMessage;
		const lastAnswer = async () =>
			unwrap(await listAnswers(orgId, userId)).find((one) => one.personaId === persona);

		const thread = await open('Who wrote about the pricing review?');
		expect((await lastMessage())?.text).toBe('Who wrote about the pricing review?');

		const job = await claim(thread.id, 'worker-r');
		unwrap(
			await completeInference(
				job.id,
				'worker-r',
				thread.id,
				said('Dana did.'),
				{end: {outcome: 'Dana did.'}},
				readyForInference,
			),
		);
		const answer = unwrap(await listEntries(thread.id)).at(-1);
		expect(await lastMessage()).toMatchObject({kind: 'assistant', text: 'Dana did.'});
		expect(await lastAnswer()).toMatchObject({
			answer: {id: answer?.id, text: 'Dana did.'},
			unread: true,
		});

		expect(unwrap(await markChatRead(chat.id, answer?.id ?? ''))).toBe(true);
		expect((await lastAnswer())?.unread).toBe(false);

		// An entry of another chat's is not this chat's to be read up to.
		const elsewhere = await db.agentThread.create({
			data: {orgId, agentId, personaId: persona, userId, title: 'Find the invoices'},
		});
		const elsewhereAnswer = await db.agentEntry.create({
			data: {threadId: elsewhere.id, kind: 'assistant', text: 'Found them.'},
		});
		expect(unwrap(await markChatRead(chat.id, elsewhereAnswer.id))).toBe(false);
		await db.agentThread.delete({where: {id: elsewhere.id}});
		expect((await lastAnswer())?.answer.text).toBe('Dana did.');
	});

	test('an alert set in a thread is the thread’s: listed with it and with its persona, and when it fires it lands in the thread, taking it up', async () => {
		const thread = await open('Remind me about the pricing review tomorrow');
		const job = await claim(thread.id, 'worker-al');
		const set = {id: 'c1', name: 'set_alert', arguments: '{}'};
		unwrap(
			await completeInference(
				job.id,
				'worker-al',
				thread.id,
				{...said('Setting it.'), toolCalls: [set]},
				{plans: {c1: {kind: 'job', runAt: new Date()}}},
				readyForInference,
			),
		);
		const tool = await db.agentJob.findFirstOrThrow({
			where: {threadId: thread.id, kind: 'tool', status: 'queued'},
		});
		await db.agentJob.update({
			where: {id: tool.id},
			data: {status: 'running', claimedBy: 'worker-al'},
		});
		const at = new Date(Date.now() + 86_400_000);
		unwrap(
			await completeSetAlert(
				{jobId: tool.id, workerId: 'worker-al', threadId: thread.id, callId: 'c1'},
				{kind: 'time', title: 'Pricing review', brief: 'Remind them.', at},
				(made) => `Set ${made.id}.`,
				readyForInference,
			),
		);
		const next = await claim(thread.id, 'worker-al2');
		unwrap(
			await completeInference(
				next.id,
				'worker-al2',
				thread.id,
				said('Set for tomorrow.'),
				{end: {outcome: 'Set for tomorrow.'}},
				readyForInference,
			),
		);
		expect((await taskOf(thread)).finishedAt).not.toBeNull();

		const alerts = unwrap(await listThreadAlerts(thread.id));
		expect(alerts.map((alert) => [alert.threadId, alert.title])).toEqual([
			[thread.id, 'Pricing review'],
		]);
		expect(unwrap(await listThreadAlerts(chat.id))).toEqual([]);
		const alert = alerts[0];
		if (!alert) {
			throw new Error('no alert');
		}
		expect(
			unwrap(await listMemberAlerts(orgId, userId)).map((one) => [one.id, one.persona.id]),
		).toEqual([[alert.id, chat.personaId]]);
		expect(
			unwrap(await fireAlert(alert, 'The alert “Pricing review” is due now.', readyForInference)),
		).toBe(true);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			text: 'The alert “Pricing review” is due now.',
		});
		expect((await taskOf(thread)).finishedAt).toBeNull();
		expect(await openTurns(thread.id)).toBe(1);
		expect(unwrap(await listEntries(chat.id))).toEqual([]);
		expect(await openTurns(chat.id)).toBe(0);
	});

	// Ends the thread's queued turn with an answer of `text`, as `workerId`.
	async function answer(thread: ThreadRow, workerId: string, text: string): Promise<void> {
		const job = await claim(thread.id, workerId);
		unwrap(
			await completeInference(
				job.id,
				workerId,
				thread.id,
				said(text),
				{end: {outcome: text}},
				readyForInference,
			),
		);
	}

	// The thread's standing, as the chat lists it.
	async function standingOf(thread: ThreadRow) {
		return unwrap(await getChatThread(chat.id, thread.id, []))?.standing;
	}

	// The seq of the thread's last entry.
	async function lastSeq(thread: ThreadRow): Promise<number> {
		return unwrap(await listEntries(thread.id)).at(-1)?.seq ?? 0;
	}

	test('a thread opens done with no summary; where it stands is written as its turn ended, and the member’s reply takes it up, waiting for nobody', async () => {
		const thread = await open('Add a date filter to the activity log, plan first');
		expect(await standingOf(thread)).toEqual({
			waitingForMember: false,
			summary: null,
			summarySeq: null,
		});
		// Nothing is written while the thread is at work.
		expect(
			unwrap(
				await writeThreadStanding(
					thread.id,
					{summary: 'Planning.', waitingForMember: true},
					await lastSeq(thread),
				),
			),
		).toBe(false);

		await answer(thread, 'worker-st1', 'I have a plan. Should it cover the CSV export too?');
		const upTo = await lastSeq(thread);
		const summary = 'Has a plan, and asks whether the date range should cover the CSV export too.';
		expect(
			unwrap(await writeThreadStanding(thread.id, {summary, waitingForMember: true}, upTo)),
		).toBe(true);
		expect(await standingOf(thread)).toEqual({waitingForMember: true, summary, summarySeq: upTo});

		unwrap(await replyInThread(chat.id, thread.id, 'Yes, include it', readyForInference));
		expect(await standingOf(thread)).toEqual({waitingForMember: false, summary, summarySeq: upTo});
		// Written up to before the reply, as a model that read the thread before it came would, it is
		// not written: the reply's turn writes for it as it ends.
		await answer(thread, 'worker-st2', 'Added it, CSV export included.');
		expect(
			unwrap(
				await writeThreadStanding(thread.id, {summary: 'Stale.', waitingForMember: true}, upTo),
			),
		).toBe(false);
		expect((await standingOf(thread))?.waitingForMember).toBe(false);

		// Without saying whether it waits, as the script writes for threads from before, that is left
		// as it is.
		expect(
			unwrap(
				await writeThreadStanding(
					thread.id,
					{summary: 'Added the date range.'},
					await lastSeq(thread),
				),
			),
		).toBe(true);
		expect(await standingOf(thread)).toMatchObject({
			waitingForMember: false,
			summary: 'Added the date range.',
		});
		// A chat has no standing to write.
		expect(
			unwrap(await writeThreadStanding(chat.id, {summary: 'No.', waitingForMember: true}, 0)),
		).toBe(false);
	});

	test('an alert that fires takes a thread waiting for the member up, and a summary from before it is not written over it', async () => {
		const thread = await open('Tell me when the nightly backup fails');
		await answer(thread, 'worker-st3', 'Watching for it. Should I look into why when it does?');
		const upTo = await lastSeq(thread);
		unwrap(
			await writeThreadStanding(
				thread.id,
				{
					summary: 'Watches the backup, and asks whether to look into failures.',
					waitingForMember: true,
				},
				upTo,
			),
		);
		const alert = await db.agentAlert.create({
			data: {
				orgId,
				userId,
				threadId: thread.id,
				title: 'Backup',
				brief: 'Check it.',
				at: new Date(),
			},
		});

		unwrap(await fireAlert(alert, 'The alert “Backup” is due now.', readyForInference));

		expect((await standingOf(thread))?.waitingForMember).toBe(false);
		await answer(thread, 'worker-st4', 'It failed twice over the weekend.');
		expect(
			unwrap(await writeThreadStanding(thread.id, {summary: 'Old.', waitingForMember: true}, upTo)),
		).toBe(false);
	});

	test('the member marks a thread of their chat done; a thread of another chat is not theirs to mark', async () => {
		const thread = await open('Check the coverage of the api package');
		await answer(thread, 'worker-st5', 'Should I include the scripts?');
		unwrap(
			await writeThreadStanding(
				thread.id,
				{summary: 'Asks whether to include the scripts.', waitingForMember: true},
				await lastSeq(thread),
			),
		);

		expect(unwrap(await markThreadDone(chat.id, thread.id))).toBe(true);
		expect(await standingOf(thread)).toMatchObject({
			waitingForMember: false,
			summary: 'Asks whether to include the scripts.',
		});
		expect(unwrap(await markThreadDone(chat.id, 'no-such-thread'))).toBe(false);
		expect(unwrap(await markThreadDone('another-chat', thread.id))).toBe(false);
		expect(unwrap(await markThreadDone(chat.id, chat.id))).toBe(false);
	});

	test('the threads without a summary are every chat’s threads that have none, the oldest first, no chat among them', async () => {
		const first = await open('Bump vite to 8.4');
		const second = await open('Fix the login test on main');
		await answer(first, 'worker-st6', 'Bumped.');
		await answer(second, 'worker-st7', 'Fixed in #411.');
		unwrap(
			await writeThreadStanding(
				second.id,
				{summary: 'Fixed in #411.', waitingForMember: false},
				await lastSeq(second),
			),
		);

		const ids = unwrap(await listThreadsWithoutSummary()).map((thread) => thread.id);
		const mine = new Set(
			(await db.agentThread.findMany({where: {orgId}, select: {id: true}})).map(
				(thread) => thread.id,
			),
		);
		const listed = ids.filter((id) => mine.has(id));

		expect(listed).toContain(first.id);
		expect(listed).not.toContain(second.id);
		expect(listed).not.toContain(chat.id);
		const created = await db.agentThread.findMany({
			where: {id: {in: listed}},
			select: {id: true, createdAt: true},
			orderBy: [{createdAt: 'asc'}, {id: 'asc'}],
		});
		expect(listed).toEqual(created.map((thread) => thread.id));
		expect(
			unwrap(await listThreadsWithoutSummary()).find((thread) => thread.id === first.id)?.chatId,
		).toBe(chat.id);
	});
});
