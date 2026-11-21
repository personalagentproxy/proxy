import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {completeSetAlert, fireAlert, listMemberAlerts} from './alerts';
import {
	getOrgSlug,
	getThreadAddress,
	isSlackThread,
	listMemberThreads,
	listRecentMemberThreads,
} from './chat';
import {createStarterConnections} from './organization';
import {
	appendEntry,
	archiveThread,
	renameThread,
	appendTurnEntries,
	changeMemberThreadStanding,
	completeInference,
	createPersona,
	ensureMemberChat,
	failJob,
	getChatThread,
	getMemberThread,
	getShownThread,
	getThreadDraft,
	hasChatThread,
	listAnswers,
	listChatThreads,
	listEntries,
	listPendingMessages,
	listPersonas,
	listThreadsWithoutSummary,
	listThreadsWithoutTitle,
	lockThread,
	markThreadRead,
	markThreadDone,
	openThread,
	passOnToThread,
	replyInThread,
	saveChatDraft,
	saveThreadDraft,
	setThreadModel,
	threadNeedsTitle,
	writeThreadStanding,
	writeThreadTitle,
	type JobRow,
	type ThreadOpening,
	type ThreadRow,
} from './harness';

// A chat's threads, against a database, as harness.test.ts runs: with `bun run test:db` from the
// repository's root; skipped without DATABASE_URL. Everything made here is one organization's, deleted at the end. The
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
				providerId: 'proxy',
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
		// Each entry as a thread shows it, with where it was passed on from, without what the model
		// was sent for it.
		expect(Object.keys(listed?.entries[0] ?? {}).toSorted()).toEqual(
			[
				'callId',
				'createdAt',
				'id',
				'isError',
				'kind',
				'passedOn',
				'pending',
				'seq',
				'text',
				'toolCalls',
			].toSorted(),
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

	test('the chat’s last message and its last answer take its threads in, and each thread is unread, and read, on its own', async () => {
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
		const dana = {id: answer?.id ?? '', text: 'Dana did.'};
		expect((await lastAnswer())?.answer).toEqual(dana);
		// The thread is unread, its turn ended with it, as the chat's earlier threads are with theirs.
		const unreadIn = async (id: string) =>
			(await lastAnswer())?.unread.find((one) => one.threadId === id) ?? null;
		expect(await unreadIn(thread.id)).toEqual({threadId: thread.id, answer: dana, ended: true});

		// A thread's turn has ended while it sleeps until later, and not while a job of it is due.
		const sleep = await db.agentJob.create({
			data: {threadId: thread.id, kind: 'wake', runAt: new Date(Date.now() + 60 * 60 * 1000)},
		});
		expect((await unreadIn(thread.id))?.ended).toBe(true);
		await db.agentJob.update({where: {id: sleep.id}, data: {runAt: new Date(Date.now() - 1000)}});
		expect((await unreadIn(thread.id))?.ended).toBe(false);
		await db.agentJob.update({where: {id: sleep.id}, data: {status: 'done'}});
		expect((await unreadIn(thread.id))?.ended).toBe(true);

		// Another thread at work says something newer: it is the chat's last answer, unread with its
		// turn under way, and read on its own; the first thread's is still unread, apart.
		const other = await open('Find the October invoices');
		const looking = await db.agentEntry.create({
			data: {threadId: other.id, kind: 'assistant', text: 'Looking.'},
		});
		expect((await lastAnswer())?.answer).toEqual({id: looking.id, text: 'Looking.'});
		expect(await unreadIn(other.id)).toEqual({
			threadId: other.id,
			answer: {id: looking.id, text: 'Looking.'},
			ended: false,
		});
		expect(unwrap(await markThreadRead(chat.id, looking.id))).toBe(true);
		expect(await unreadIn(other.id)).toBeNull();
		expect((await unreadIn(thread.id))?.answer).toEqual(dana);
		await db.agentEntry.delete({where: {id: looking.id}});

		expect(unwrap(await markThreadRead(chat.id, answer?.id ?? ''))).toBe(true);
		expect(await unreadIn(thread.id)).toBeNull();

		// An entry of another chat's is not this chat's to be read up to.
		const elsewhere = await db.agentThread.create({
			data: {orgId, agentId, personaId: persona, userId, title: 'Find the invoices'},
		});
		const elsewhereAnswer = await db.agentEntry.create({
			data: {threadId: elsewhere.id, kind: 'assistant', text: 'Found them.'},
		});
		expect(unwrap(await markThreadRead(chat.id, elsewhereAnswer.id))).toBe(false);
		await db.agentThread.delete({where: {id: elsewhere.id}});
		expect((await lastAnswer())?.answer.text).toBe('Dana did.');
	});

	test('the member’s reply reads its thread, which isn’t unread while it works on it; what its agent says after is', async () => {
		const unreadIn = async (id: string) =>
			unwrap(await listAnswers(orgId, userId))
				.find((one) => one.personaId === chat.personaId)
				?.unread.find((one) => one.threadId === id) ?? null;
		const thread = await open('Which invoices are overdue?');
		const first = await claim(thread.id, 'worker-u');
		unwrap(
			await completeInference(
				first.id,
				'worker-u',
				thread.id,
				said('Three are.'),
				{end: {outcome: 'Three are.'}},
				readyForInference,
			),
		);
		expect((await unreadIn(thread.id))?.answer.text).toBe('Three are.');

		unwrap(await replyInThread(chat.id, thread.id, 'Which ones?', readyForInference));
		expect(await unreadIn(thread.id)).toBeNull();

		const next = await claim(thread.id, 'worker-u');
		unwrap(
			await completeInference(
				next.id,
				'worker-u',
				thread.id,
				said('March, April and May.'),
				{end: {outcome: 'Listed them.'}},
				readyForInference,
			),
		);
		expect((await unreadIn(thread.id))?.answer.text).toBe('March, April and May.');
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
				{kind: 'time', opens: 'this_thread', title: 'Pricing review', brief: 'Remind them.', at},
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

		// The member's alerts have it, with the thread it was set in, where it comes, and whom with.
		const alerts = unwrap(await listMemberAlerts(orgId, userId));
		expect(
			alerts.map((one) => [one.threadId, one.title, one.thread?.title, one.persona.id]),
		).toEqual([
			[thread.id, 'Pricing review', 'Remind me about the pricing review tomorrow', chat.personaId],
		]);
		const alert = alerts[0];
		if (!alert) {
			throw new Error('no alert');
		}
		expect(
			unwrap(
				await fireAlert(
					alert,
					{text: 'The alert “Pricing review” is due now.', opening: null},
					null,
					readyForInference,
				),
			),
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
			archived: false,
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
		expect(await standingOf(thread)).toEqual({
			waitingForMember: true,
			summary,
			summarySeq: upTo,
			archived: false,
		});

		unwrap(await replyInThread(chat.id, thread.id, 'Yes, include it', readyForInference));
		expect(await standingOf(thread)).toEqual({
			waitingForMember: false,
			summary,
			summarySeq: upTo,
			archived: false,
		});
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
				chatId: chat.id,
				threadId: thread.id,
				title: 'Backup',
				brief: 'Check it.',
				at: new Date(),
			},
		});

		unwrap(
			await fireAlert(
				alert,
				{text: 'The alert “Backup” is due now.', opening: null},
				null,
				readyForInference,
			),
		);

		expect((await standingOf(thread))?.waitingForMember).toBe(false);
		await answer(thread, 'worker-st4', 'It failed twice over the weekend.');
		expect(
			unwrap(await writeThreadStanding(thread.id, {summary: 'Old.', waitingForMember: true}, upTo)),
		).toBe(false);
	});

	test('where a thread stands is written while it works only where said to be, never whether it waits, never over one written from further on, and not once something came', async () => {
		const thread = await open('Standing at work: move the pricing review');
		const asked = await lastSeq(thread);

		// Its turn is still to run: as a turn's end, nothing is written; as its agent told the member
		// something and went on, the sentence is, and whether it waits is left.
		expect(
			unwrap(
				await writeThreadStanding(thread.id, {summary: 'Moved.', waitingForMember: true}, asked),
			),
		).toBe(false);
		expect(
			unwrap(
				await writeThreadStanding(thread.id, {summary: 'Checking the calendar.'}, asked, true),
			),
		).toBe(true);
		expect(await standingOf(thread)).toEqual({
			waitingForMember: false,
			summary: 'Checking the calendar.',
			summarySeq: asked,
			archived: false,
		});

		// The turn ends, and its end is written; the sentence of the step before, read by a model
		// that took longer, does not come back over it.
		await answer(thread, 'worker-sw1', 'Moved it to Friday. Should Dana be told?');
		const answered = await lastSeq(thread);
		expect(
			unwrap(
				await writeThreadStanding(
					thread.id,
					{summary: 'Moved to Friday; asks whether to tell Dana.', waitingForMember: true},
					answered,
				),
			),
		).toBe(true);
		expect(
			unwrap(
				await writeThreadStanding(thread.id, {summary: 'Checking the calendar.'}, asked, true),
			),
		).toBe(false);
		expect(await standingOf(thread)).toEqual({
			waitingForMember: true,
			summary: 'Moved to Friday; asks whether to tell Dana.',
			summarySeq: answered,
			archived: false,
		});

		// The member replies: what was read before the reply is not written, at work or not.
		unwrap(await replyInThread(chat.id, thread.id, 'Yes, tell Dana', readyForInference));
		expect(unwrap(await writeThreadStanding(thread.id, {summary: 'Stale.'}, answered, true))).toBe(
			false,
		);
		expect((await standingOf(thread))?.summary).toBe('Moved to Friday; asks whether to tell Dana.');
		await db.agentJob.updateMany({where: {threadId: thread.id}, data: {status: 'done'}});
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

	test('the member archives a thread, which leaves the chat’s list until they reply in it, and is still read by its id', async () => {
		const thread = await open('Archive me once done');
		await answer(thread, 'worker-ar1', 'Done: the report is in your drive.');
		const listed = async () => unwrap(await listChatThreads(chat.id, [])).map((one) => one.id);
		const unread = async () =>
			unwrap(await listAnswers(orgId, userId))
				.find((one) => one.personaId === chat.personaId)
				?.unread.some((one) => one.threadId === thread.id);
		expect(await unread()).toBe(true);

		expect(unwrap(await archiveThread(chat.id, thread.id))).toBe(true);
		expect(await listed()).not.toContain(thread.id);
		expect((await standingOf(thread))?.archived).toBe(true);
		// Its answer, unread when it was archived, is no longer: the list has no thread to open it by.
		expect(await unread()).toBe(false);
		// The member's Chat connection still lists it, as archived, and not as done.
		const member = async (standing: 'archived' | 'done') =>
			(
				unwrap(
					await listMemberThreads(orgId, userId, {
						search: 'Archive me',
						standing,
						skip: 0,
						take: 10,
					}),
				)?.threads ?? []
			).map((one) => one.id);
		expect(await member('archived')).toEqual([thread.id]);
		expect(await member('done')).toEqual([]);

		unwrap(await replyInThread(chat.id, thread.id, 'One more thing', readyForInference));
		expect(await listed()).toContain(thread.id);
		expect((await standingOf(thread))?.archived).toBe(false);
		expect(await member('archived')).toEqual([]);

		expect(unwrap(await archiveThread(chat.id, 'no-such-thread'))).toBe(false);
		expect(unwrap(await archiveThread('another-chat', thread.id))).toBe(false);
		expect(unwrap(await archiveThread(chat.id, chat.id))).toBe(false);
	});

	test('the member’s threads are listed for their Chat connection whichever persona each is with, the one opened last first, by their rows alone, narrowed and searched, and one is read whole', async () => {
		const first = await open('Chat connection: find the invoices');
		await answer(first, 'worker-cc1', 'Which month?');
		const upTo = await lastSeq(first);
		unwrap(
			await writeThreadStanding(
				first.id,
				{summary: 'Asks which month the invoices are for.', waitingForMember: true},
				upTo,
			),
		);
		const second = await open('Chat connection: book a room');
		const now = new Date();
		const everything = {search: null, standing: null, skip: 0, take: 10};

		const mine = async (query: Partial<Parameters<typeof listMemberThreads>[2]> = {}) => {
			const narrowed = {...everything, search: 'chat connection', ...query};
			return unwrap(await listMemberThreads(orgId, userId, narrowed, now))?.threads ?? [];
		};

		const both = await mine();
		expect(both.map((thread) => thread.id)).toEqual([second.id, first.id]);
		expect(both[1]).toMatchObject({
			personaId: chat.personaId,
			personaName: 'Finance',
			title: 'Chat connection: find the invoices',
			state: {kind: 'stopped'},
			standing: {
				waitingForMember: true,
				summary: 'Asks which month the invoices are for.',
				summarySeq: upTo,
			},
			last: {seq: upTo, pending: false},
		});
		// One at work has what the member said as its last.
		expect(both[0]).toMatchObject({state: {kind: 'working'}, last: {pending: false}});
		expect(unwrap(await listMemberThreads(orgId, userId, everything))?.orgSlug).toBe(
			`chat-threads-test-${stamp}`,
		);

		// By where each stands, by its summary's words, and a page at a time.
		expect((await mine({standing: 'waiting'})).map((thread) => thread.id)).toEqual([first.id]);
		expect((await mine({standing: 'in_progress'})).map((thread) => thread.id)).toEqual([second.id]);
		expect(await mine({standing: 'done'})).toEqual([]);
		expect(await mine({standing: 'archived'})).toEqual([]);
		expect((await mine({search: 'WHICH MONTH'})).map((thread) => thread.id)).toEqual([first.id]);
		expect((await mine({skip: 1, take: 1})).map((thread) => thread.id)).toEqual([first.id]);
		// Nobody else's, and no other organization's.
		expect(unwrap(await listMemberThreads(orgId, 'another-user', everything))?.threads).toEqual([]);
		expect(unwrap(await listMemberThreads('no-such-org', userId, everything))).toBeNull();

		// One of theirs is read whole, as its chat reads it; never the chat itself, or another's.
		const read = unwrap(await getMemberThread({orgId, userId}, first.id, []));
		expect(read?.entries.map((entry) => [entry.kind, entry.text])).toEqual([
			['person', 'Chat connection: find the invoices'],
			['assistant', 'Which month?'],
		]);
		expect(unwrap(await getMemberThread({orgId, userId}, chat.id, []))).toBeNull();
		expect(unwrap(await getMemberThread({orgId, userId: 'another-user'}, first.id, []))).toBeNull();

		expect(unwrap(await getThreadAddress({id: first.id, orgId}))).toEqual({
			orgSlug: `chat-threads-test-${stamp}`,
			personaName: 'Finance',
			slack: null,
		});
		expect(unwrap(await getThreadAddress({id: 'no-such-thread', orgId}))).toBeNull();
		expect(unwrap(await getThreadAddress({id: first.id, orgId: 'no-such-org'}))).toBeNull();
		expect(unwrap(await getOrgSlug(orgId))).toBe(`chat-threads-test-${stamp}`);
		expect(unwrap(await getOrgSlug('no-such-org'))).toBeNull();
		await db.agentJob.updateMany({where: {threadId: second.id}, data: {status: 'done'}});
	});

	test('a thread in Slack lives there alone, with its sub-agents: the app doesn’t list it, find it, count it in the chat’s last message or unread marks, or write to it, while its agent and the Chat connection read it with its place', async () => {
		const inApp = await open('Pricing review with Dana');
		await answer(inApp, 'worker-sl1', 'Dana sent the deck.');
		const thread = await open('Plan the offsite in Lisbon');
		const workspace = await db.slackWorkspace.create({
			data: {
				orgId,
				teamId: `T-${stamp}`,
				name: 'Northwind',
				slackUserId: 'U00',
				credential: 'sealed',
				expiresAt: new Date(),
				rotateAt: new Date(),
			},
		});
		const app = await db.slackApp.create({
			data: {
				orgId,
				personaId: chat.personaId,
				workspaceId: workspace.id,
				manifestVersion: 1,
				manifestName: 'Finance',
			},
		});
		await db.slackThreadPlace.create({
			data: {appId: app.id, channel: 'D01', rootTs: '1800000000.000100', threadId: thread.id},
		});
		await answer(thread, 'worker-sl2', 'Three hotels near the river.');
		const slackAnswer = unwrap(await listEntries(thread.id)).at(-1);
		unwrap(
			await writeThreadStanding(
				thread.id,
				{summary: 'Found three hotels.', waitingForMember: true},
				await lastSeq(thread),
			),
		);
		// A sub-agent its agent started, which is in Slack with it.
		const subAgent = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: chat.personaId,
				userId,
				parentThreadId: chat.id,
				subAgentOfId: thread.id,
				parentCallId: 'call-1',
				title: 'Hotels near the river',
			},
		});
		await db.agentEntry.create({
			data: {threadId: subAgent.id, kind: 'assistant', text: 'The sub-agent’s own answer.'},
		});
		const alert = await db.agentAlert.create({
			data: {
				orgId,
				userId,
				chatId: chat.id,
				threadId: thread.id,
				setInThreadId: thread.id,
				title: 'Offsite deposit',
				brief: 'Remind them to pay it.',
				at: new Date(Date.now() + 60 * 60 * 1000),
				nextAt: new Date(Date.now() + 60 * 60 * 1000),
			},
		});

		// Not in the chat's list, nor by its address, its sub-agent neither; nor in what the sidebar
		// and the notifications read.
		expect(unwrap(await listChatThreads(chat.id, [])).map((one) => one.id)).not.toContain(
			thread.id,
		);
		for (const hidden of [thread.id, subAgent.id]) {
			expect(unwrap(await getChatThread(chat.id, hidden, []))).toBeNull();
			expect(unwrap(await hasChatThread(chat.id, hidden))).toBe(false);
		}
		expect(unwrap(await hasChatThread(chat.id, inApp.id))).toBe(true);
		const persona = unwrap(await listPersonas(orgId, userId)).find(
			(one) => one.id === chat.personaId,
		);
		expect(persona?.lastMessage?.text).toBe('Dana sent the deck.');
		const answers = unwrap(await listAnswers(orgId, userId)).find(
			(one) => one.personaId === chat.personaId,
		);
		expect(answers?.answer.text).toBe('Dana sent the deck.');
		expect(answers?.unread.map((one) => one.threadId)).not.toContain(thread.id);
		expect(unwrap(await markThreadRead(chat.id, slackAnswer?.id ?? ''))).toBe(false);

		// Nothing the app does writes to it.
		const entries = unwrap(await listEntries(thread.id)).length;
		expect(
			unwrap(await replyInThread(chat.id, thread.id, 'Book the second', readyForInference)),
		).toBeNull();
		expect(unwrap(await markThreadDone(chat.id, thread.id))).toBe(false);
		expect(unwrap(await archiveThread(chat.id, thread.id))).toBe(false);
		expect(unwrap(await renameThread(chat.id, thread.id, 'Lisbon'))).toBe(false);
		expect(unwrap(await saveThreadDraft(chat.id, thread.id, 'Half typed'))).toBe(false);
		expect(unwrap(await getThreadDraft(chat.id, thread.id))).toBeNull();
		expect(
			unwrap(await setThreadModel(chat.id, thread.id, {harness: 'other', chatModel: 'other'})),
		).toBe(false);
		expect(unwrap(await listEntries(thread.id))).toHaveLength(entries);
		const kept = unwrap(await getShownThread(thread.id, []));
		expect(kept?.standing).toMatchObject({waitingForMember: true, archived: false});
		expect(kept?.title).toBe('Plan the offsite in Lisbon');
		expect(await db.agentAlert.count({where: {id: alert.id}})).toBe(1);

		// What its agent and the worker read of it is any thread's; never a chat.
		expect(kept?.entries.map((entry) => entry.text)).toEqual([
			'Plan the offsite in Lisbon',
			'Three hotels near the river.',
		]);
		expect(unwrap(await getShownThread(chat.id, []))).toBeNull();

		// The member's Chat connection lists it and reads it, with where it is in Slack, and so do
		// their alerts.
		const slack = {teamId: `T-${stamp}`, channel: 'D01', rootTs: '1800000000.000100'};
		const listed = unwrap(
			await listMemberThreads(orgId, userId, {search: null, standing: null, skip: 0, take: 50}),
		)?.threads;
		expect(listed?.find((one) => one.id === thread.id)?.slack).toEqual(slack);
		expect(listed?.find((one) => one.id === inApp.id)?.slack).toBeNull();
		expect(unwrap(await getMemberThread({orgId, userId}, thread.id, []))?.id).toBe(thread.id);
		expect(unwrap(await getThreadAddress({id: thread.id, orgId}))).toMatchObject({slack});
		const set = unwrap(await listMemberAlerts(orgId, userId)).find((one) => one.id === alert.id);
		expect(set?.thread).toEqual({id: thread.id, title: 'Plan the offsite in Lisbon', slack});
		expect(set?.setIn?.slack).toEqual(slack);

		await db.agentAlert.delete({where: {id: alert.id}});
		await db.slackApp.delete({where: {id: app.id}});
		await db.slackWorkspace.delete({where: {id: workspace.id}});
		await db.agentThread.deleteMany({where: {id: {in: [thread.id, subAgent.id, inApp.id]}}});
	});

	test('the member’s Chat connection changes where any of their threads stands, in the app or in Slack, once it and its sub-agents have stopped, and archives none an alert still comes to', async () => {
		const member = {orgId, userId};
		const waiting = await open('Standing: pricing review with Dana');
		await answer(waiting, 'worker-ms1', 'Which day suits Dana?');
		unwrap(
			await writeThreadStanding(
				waiting.id,
				{summary: 'Asks which day suits Dana.', waitingForMember: true},
				await lastSeq(waiting),
			),
		);
		const working = await open('Standing: book the train to Lyon');
		const standing = async (thread: ThreadRow) =>
			db.agentThread.findUniqueOrThrow({
				where: {id: thread.id},
				select: {waitingForMember: true, archived: true},
			});

		// One at work is refused, whatever is asked.
		for (const change of ['done', 'archive', 'unarchive'] as const) {
			expect(unwrap(await changeMemberThreadStanding(member, working.id, change))).toBe(
				'in_progress',
			);
		}
		expect(await standing(working)).toEqual({waitingForMember: false, archived: false});

		// Marked done, its alerts kept, so it is watching.
		const alert = await db.agentAlert.create({
			data: {
				orgId,
				userId,
				chatId: chat.id,
				threadId: waiting.id,
				setInThreadId: waiting.id,
				title: 'Dana’s answer',
				brief: 'See whether Dana answered.',
				at: new Date(Date.now() + 60 * 60 * 1000),
				nextAt: new Date(Date.now() + 60 * 60 * 1000),
			},
		});
		expect(unwrap(await changeMemberThreadStanding(member, waiting.id, 'done'))).toBe('changed');
		expect(await standing(waiting)).toEqual({waitingForMember: false, archived: false});
		expect(await db.agentAlert.count({where: {id: alert.id}})).toBe(1);

		// Not archived while the alert still comes to it; once it is cancelled, archived, and
		// brought back.
		expect(unwrap(await changeMemberThreadStanding(member, waiting.id, 'archive'))).toBe(
			'watching',
		);
		expect((await standing(waiting)).archived).toBe(false);
		await db.agentAlert.delete({where: {id: alert.id}});
		expect(unwrap(await changeMemberThreadStanding(member, waiting.id, 'archive'))).toBe('changed');
		expect((await standing(waiting)).archived).toBe(true);
		expect(unwrap(await changeMemberThreadStanding(member, waiting.id, 'unarchive'))).toBe(
			'changed',
		);
		expect((await standing(waiting)).archived).toBe(false);

		// While a sub-agent of its is at work, it is in progress too; the sub-agent is no thread of
		// the member's.
		const subAgent = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: chat.personaId,
				userId,
				parentThreadId: chat.id,
				subAgentOfId: waiting.id,
				parentCallId: 'call-ms1',
				title: 'Dana’s calendar',
			},
		});
		const subJob = await db.agentJob.create({data: {threadId: subAgent.id, kind: 'inference'}});
		expect(unwrap(await changeMemberThreadStanding(member, waiting.id, 'archive'))).toBe(
			'in_progress',
		);
		expect(unwrap(await changeMemberThreadStanding(member, subAgent.id, 'done'))).toBeNull();
		await db.agentJob.update({where: {id: subJob.id}, data: {status: 'done'}});

		// Nobody else’s, no chat, and nothing that isn’t there.
		expect(
			unwrap(await changeMemberThreadStanding({orgId, userId: 'someone-else'}, waiting.id, 'done')),
		).toBeNull();
		expect(unwrap(await changeMemberThreadStanding(member, chat.id, 'done'))).toBeNull();
		expect(unwrap(await changeMemberThreadStanding(member, 'no-such-thread', 'done'))).toBeNull();

		// A thread in Slack, which the app can’t write to, is archived here as any is.
		const inSlack = await open('Standing: plan the offsite in Lisbon');
		const workspace = await db.slackWorkspace.create({
			data: {
				orgId,
				teamId: `T-ms-${stamp}`,
				name: 'Northwind',
				slackUserId: 'U00',
				credential: 'sealed',
				expiresAt: new Date(),
				rotateAt: new Date(),
			},
		});
		const app = await db.slackApp.create({
			data: {
				orgId,
				personaId: chat.personaId,
				workspaceId: workspace.id,
				manifestVersion: 1,
				manifestName: 'Finance',
			},
		});
		await db.slackThreadPlace.create({
			data: {appId: app.id, channel: 'D01', rootTs: '1800000000.000200', threadId: inSlack.id},
		});
		await answer(inSlack, 'worker-ms2', 'Three hotels near the river.');
		expect(unwrap(await isSlackThread(inSlack.id))).toBe(true);
		expect(unwrap(await isSlackThread(waiting.id))).toBe(false);
		expect(unwrap(await archiveThread(chat.id, inSlack.id))).toBe(false);
		expect(unwrap(await changeMemberThreadStanding(member, inSlack.id, 'archive'))).toBe('changed');
		expect((await standing(inSlack)).archived).toBe(true);
		unwrap(await changeMemberThreadStanding(member, inSlack.id, 'unarchive'));

		// What a thread's agent is told of the others: the latest first, by what was last said in
		// each, wherever each lives, but itself, those archived and sub-agents'.
		await answer(working, 'worker-ms3', 'Booked the 9:04.');
		const recent = async (take: number) =>
			unwrap(await listRecentMemberThreads(member, waiting.id, take)).map((one) => one.id);
		expect(await recent(2)).toEqual([working.id, inSlack.id]);
		const lines = unwrap(await listRecentMemberThreads(member, waiting.id, 2));
		expect(lines[1]).toMatchObject({
			title: 'Standing: plan the offsite in Lisbon',
			personaName: 'Finance',
			slack: {teamId: `T-ms-${stamp}`, channel: 'D01', rootTs: '1800000000.000200'},
			state: {kind: 'stopped'},
		});
		unwrap(await changeMemberThreadStanding(member, inSlack.id, 'archive'));
		const all = await recent(100);
		expect(all[0]).toBe(working.id);
		for (const left of [waiting.id, inSlack.id, subAgent.id, chat.id]) {
			expect(all).not.toContain(left);
		}

		await db.slackApp.delete({where: {id: app.id}});
		await db.slackWorkspace.delete({where: {id: workspace.id}});
		await db.agentThread.deleteMany({
			where: {id: {in: [waiting.id, working.id, inSlack.id, subAgent.id]}},
		});
	});

	test('a thread passes the member’s message on to another of theirs, which takes it as their reply: it wakes, comes back from the archive and waits for nobody, stays unread as far as it was, and nothing comes back', async () => {
		const member = {orgId, userId};
		const unreadIn = async (id: string) =>
			unwrap(await listAnswers(orgId, userId))
				.find((one) => one.personaId === chat.personaId)
				?.unread.find((one) => one.threadId === id) ?? null;
		const from = await open('Pass on: upgrade vite to 7');
		const to = await open('Pass on: write the release notes');
		await answer(from, 'worker-p1', 'Shall I include the docs site?');
		await answer(to, 'worker-p2', 'Which version do the notes cover?');
		unwrap(
			await writeThreadStanding(
				to.id,
				{summary: 'Asks which version the notes cover.', waitingForMember: true},
				await lastSeq(to),
			),
		);
		expect(unwrap(await changeMemberThreadStanding(member, to.id, 'archive'))).toBe('changed');
		const fromBefore = unwrap(await listEntries(from.id)).length;

		const passed = unwrap(
			await passOnToThread(
				member,
				from.taskId ?? '',
				to.id,
				'Version 7, with the docs site',
				readyForInference,
			),
		);

		expect(passed).toMatchObject({
			sent: {
				kind: 'person',
				text: 'Version 7, with the docs site',
				passedOnFromId: from.id,
				pending: false,
			},
		});
		const shown = unwrap(await getMemberThread(member, to.id, []));
		expect(shown?.standing).toMatchObject({archived: false, waitingForMember: false});
		expect(shown?.entries.at(-1)).toMatchObject({
			kind: 'person',
			text: 'Version 7, with the docs site',
			passedOn: {
				threadId: from.id,
				thread: {id: from.id, personaId: chat.personaId, title: from.title, slack: null},
			},
		});
		expect(shown?.entries[0]?.passedOn).toBeNull();
		expect(await openTurns(to.id)).toBe(1);
		expect((await taskOf(to)).finishedAt).toBeNull();
		expect(unwrap(await listChatThreads(chat.id, [])).map((one) => one.id)).toContain(to.id);
		// The member hasn't read it for that: its answer before stays unread, and so is the next.
		expect((await unreadIn(to.id))?.answer.text).toBe('Which version do the notes cover?');
		await answer(to, 'worker-p2', 'Version 7 it is, docs site included.');
		expect((await unreadIn(to.id))?.answer.text).toBe('Version 7 it is, docs site included.');
		// Nothing lands in the thread that passed it on, nor wakes it.
		expect(unwrap(await listEntries(from.id))).toHaveLength(fromBefore);
		expect(await openTurns(from.id)).toBe(0);

		// The thread it came from is named as it is now: renamed since, by its new title.
		unwrap(await renameThread(chat.id, from.id, 'Vite 7 upgrade'));
		expect(
			unwrap(await getChatThread(chat.id, to.id, []))?.entries.at(-2)?.passedOn?.thread?.title,
		).toBe('Vite 7 upgrade');

		// Once the thread it came from is deleted, it still says it was passed on, from none.
		const gone = await open('Pass on: a thread deleted later');
		unwrap(
			await passOnToThread(
				member,
				gone.taskId ?? '',
				from.id,
				'Use the 7.1 notes',
				readyForInference,
			),
		);
		await db.agentThread.delete({where: {id: gone.id}});
		expect(unwrap(await getMemberThread(member, from.id, []))?.entries.at(-1)?.passedOn).toEqual({
			threadId: gone.id,
			thread: null,
		});
		await db.agentThread.deleteMany({where: {id: {in: [from.id, to.id]}}});
	});

	test('a message is passed on only by a thread of the member’s, not a sub-agent, to another of theirs; not by a thread whose latest message from them was passed on to it, until they write in it, whatever came between', async () => {
		const member = {orgId, userId};
		const from = await open('Chain: plan the offsite');
		const to = await open('Chain: book the venue');
		const send = async (sender: {id: string}, threadId: string) => {
			const {taskId} = await db.agentThread.findUniqueOrThrow({
				where: {id: sender.id},
				select: {taskId: true},
			});
			return unwrap(
				await passOnToThread(
					member,
					taskId ?? '',
					threadId,
					'For twelve people',
					readyForInference,
				),
			);
		};

		// A caller whose task is no thread's, nor a thread of the member's.
		const task = await db.agentTask.create({
			data: {
				orgId,
				agentId,
				ownerUserId: userId,
				title: 'Not a thread',
				goal: 'Not a thread',
				via: 'mcp',
			},
		});
		expect(unwrap(await passOnToThread(member, task.id, to.id, 'Hi', readyForInference))).toEqual({
			refused: 'not_a_thread',
		});
		expect(
			unwrap(
				await passOnToThread(
					{orgId, userId: 'another-user'},
					from.taskId ?? '',
					to.id,
					'Hi',
					readyForInference,
				),
			),
		).toEqual({refused: 'not_a_thread'});
		// Never to itself.
		expect(await send(from, from.id)).toEqual({refused: 'itself'});
		// A sub-agent sends nothing, and is sent nothing: it is no thread of the member's.
		const subTask = await db.agentTask.create({
			data: {
				orgId,
				agentId,
				ownerUserId: userId,
				parentId: from.taskId,
				title: 'Venues in Lisbon',
				goal: 'Venues in Lisbon',
				via: 'harness',
			},
		});
		const subAgent = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: chat.personaId,
				userId,
				parentThreadId: chat.id,
				subAgentOfId: from.id,
				parentCallId: 'call-chain',
				title: 'Venues in Lisbon',
				taskId: subTask.id,
			},
		});
		expect(await send(subAgent, to.id)).toEqual({refused: 'sub_agent'});
		expect(await send(from, subAgent.id)).toBeNull();
		// Never to another member's thread, nor to a chat, nor to none.
		const other = await db.user.create({data: {email: `chat-threads-pass-${stamp}@example.test`}});
		const otherChat = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: chat.personaId, userId: other.id}),
		);
		const theirs = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: chat.personaId,
				userId: other.id,
				parentThreadId: otherChat.id,
				title: 'Theirs',
			},
		});
		expect(await send(from, theirs.id)).toBeNull();
		expect(await send(from, chat.id)).toBeNull();
		expect(await send(from, 'no-such-thread')).toBeNull();
		expect(
			await db.agentEntry.count({where: {threadId: {in: [theirs.id, chat.id, subAgent.id]}}}),
		).toBe(0);

		// Passed on to `to`, which then can't pass one on in turn.
		expect(await send(from, to.id)).toMatchObject({sent: {passedOnFromId: from.id}});
		expect(await send(to, from.id)).toEqual({refused: 'passed_on'});
		// An alert that came, or a sub-agent's answer, is no message from the member: still refused.
		const landed = await db.$transaction(async (tx) => {
			const locked = await lockThread(tx, to.id);
			if (!locked) {
				throw new Error('no thread');
			}
			await appendEntry(tx, locked, {kind: 'event', text: 'The venue wrote back.'}, () => false);
			return appendEntry(
				tx,
				locked,
				{kind: 'event', text: 'Three venues.', callId: 'call-venues'},
				() => false,
			);
		});
		expect(landed.kind).toBe('event');
		expect(await send(to, from.id)).toEqual({refused: 'passed_on'});
		// Once the member writes in it directly, it can, even while it is at work, as what they
		// steer its turn with is theirs.
		await claim(to.id, 'worker-chain');
		unwrap(
			await replyInThread(chat.id, to.id, 'Pass it back to the offsite thread', readyForInference),
		);
		expect(await send(to, from.id)).toMatchObject({sent: {passedOnFromId: to.id}});

		await db.agentThread.deleteMany({
			where: {id: {in: [from.id, to.id, subAgent.id, theirs.id, otherChat.id]}},
		});
		await db.agentTask.deleteMany({where: {id: {in: [task.id, subTask.id]}}});
		await db.user.delete({where: {id: other.id}});
	});

	test('a message passed on to a thread at work waits, pending, for its turn to read it at its next step, then takes its place in the log, as a reply does', async () => {
		const member = {orgId, userId};
		const from = await open('Mid-turn: collect the receipts');
		const to = await open('Mid-turn: file the expenses');
		const job = await claim(to.id, 'worker-m1');

		const passed = unwrap(
			await passOnToThread(
				member,
				from.taskId ?? '',
				to.id,
				'Include the taxi receipt',
				readyForInference,
			),
		);
		expect(passed).toMatchObject({sent: {pending: true}});
		// What the turn is given at its next step, as it is given what the member steers it with.
		expect(
			unwrap(await listPendingMessages(to.id)).map((entry) => [entry.text, entry.passedOnFromId]),
		).toEqual([['Include the taxi receipt', from.id]]);

		unwrap(
			await completeInference(
				job.id,
				'worker-m1',
				to.id,
				said('Filed four.'),
				{end: {outcome: 'Filed four.'}},
				readyForInference,
			),
		);
		expect(
			unwrap(await listEntries(to.id)).map((entry) => [
				entry.kind,
				entry.text,
				entry.passedOnFromId,
			]),
		).toEqual([
			['person', 'Mid-turn: file the expenses', null],
			['assistant', 'Filed four.', null],
			['person', 'Include the taxi receipt', from.id],
		]);
		expect(await openTurns(to.id)).toBe(1);
		expect((await taskOf(to)).finishedAt).toBeNull();
		await db.agentThread.deleteMany({where: {id: {in: [from.id, to.id]}}});
	});

	test('a member’s Chat connection, made with their membership, is given to the organization’s built-in agent alone', async () => {
		await db.$transaction((tx) =>
			createStarterConnections(
				tx,
				[{integrationId: 'chat', defaults: [], builtInGrants: ['readThreads', 'readAlerts']}],
				{
					orgId,
					userId,
					name: 'Chat threads test',
				},
			),
		);
		const connections = await db.connection.findMany({
			where: {orgId, integrationId: 'chat'},
			select: {id: true, ownerUserId: true, account: true, name: true, defaults: true},
		});
		expect(connections).toEqual([
			{
				id: expect.any(String),
				ownerUserId: userId,
				account: 'Chat threads test',
				name: null,
				defaults: [],
			},
		]);
		const grants = await db.agentGrant.findMany({
			where: {connectionId: connections[0]?.id ?? ''},
			select: {agentId: true, actionId: true, allowed: true},
			orderBy: {actionId: 'asc'},
		});
		expect(grants).toEqual([
			{agentId, actionId: 'readAlerts', allowed: true},
			{agentId, actionId: 'readThreads', allowed: true},
		]);
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
	test('a thread’s title is written once, its task named the same, and only for a chat’s thread a message opened', async () => {
		const thread = await open('can you book a table for 4 near the office thursday 7pm');
		expect(unwrap(await threadNeedsTitle(thread.id))).toBe(true);
		expect(unwrap(await threadNeedsTitle(chat.id))).toBe(false);
		const mine = async () =>
			unwrap(await listThreadsWithoutTitle())
				.map((one) => one.id)
				.filter((id) => id === thread.id || id === chat.id);
		expect(await mine()).toEqual([thread.id]);

		expect(unwrap(await writeThreadTitle(thread.id, 'Thursday dinner for four'))).toBe(true);
		expect(unwrap(await writeThreadTitle(thread.id, 'Dinner on Thursday'))).toBe(false);
		expect(unwrap(await writeThreadTitle(chat.id, 'A chat'))).toBe(false);

		const written = await db.agentThread.findUniqueOrThrow({
			where: {id: thread.id},
			select: {title: true, titleWritten: true, taskId: true},
		});
		expect(written.title).toBe('Thursday dinner for four');
		expect(written.titleWritten).toBe(true);
		const task = await db.agentTask.findUniqueOrThrow({where: {id: written.taskId ?? ''}});
		expect(task.title).toBe('Thursday dinner for four');
		expect(unwrap(await threadNeedsTitle(thread.id))).toBe(false);
		expect(await mine()).toEqual([]);
		expect((await db.agentThread.findUniqueOrThrow({where: {id: chat.id}})).title).toBeNull();

		// One an alert opened keeps the name the alert gave it.
		const alerted = await open('Bank: Your loan');
		await db.agentThread.update({where: {id: alerted.id}, data: {openedByAlert: true}});
		expect(unwrap(await threadNeedsTitle(alerted.id))).toBe(false);
		expect(unwrap(await writeThreadTitle(alerted.id, 'Loan email from the bank'))).toBe(false);
		expect(unwrap(await listThreadsWithoutTitle()).some((one) => one.id === alerted.id)).toBe(
			false,
		);
	});
	test('the member renames a thread of their chat, its task with it, and the small model names it no more', async () => {
		const thread = await open('can you book a table for 4 near the office thursday 7pm');
		expect(unwrap(await renameThread(chat.id, thread.id, 'Team dinner'))).toBe(true);
		const renamed = await db.agentThread.findUniqueOrThrow({
			where: {id: thread.id},
			select: {title: true, titleWritten: true, taskId: true},
		});
		expect(renamed.title).toBe('Team dinner');
		expect(unwrap(await threadNeedsTitle(thread.id))).toBe(false);
		expect(unwrap(await writeThreadTitle(thread.id, 'Thursday dinner for four'))).toBe(false);
		const task = await db.agentTask.findUniqueOrThrow({where: {id: renamed.taskId ?? ''}});
		expect(task.title).toBe('Team dinner');

		expect(unwrap(await renameThread(chat.id, thread.id, 'Dinner, again'))).toBe(true);
		expect(unwrap(await renameThread(chat.id, 'no-such-thread', 'X'))).toBe(false);
		expect(unwrap(await renameThread('another-chat', thread.id, 'X'))).toBe(false);
		expect(unwrap(await renameThread(chat.id, chat.id, 'X'))).toBe(false);
		expect((await db.agentThread.findUniqueOrThrow({where: {id: thread.id}})).title).toBe(
			'Dinner, again',
		);
	});
});
