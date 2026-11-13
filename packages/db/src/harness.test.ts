import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	addDraftAttachment,
	appendSummary,
	appendTurnEntries,
	claimJob,
	type ClaimedJob,
	completeInference,
	completeToolJob,
	createPersona,
	ensureFirstPersona,
	ensureMemberChat,
	failJob,
	finishJob,
	getChatDraft,
	getJobThread,
	getPersona,
	isAttachedForTask,
	listAnswers,
	listAttachments,
	listDraftAttachments,
	listEntries,
	listJobEvents,
	listPersonas,
	markChatRead,
	openThread,
	removeDraftAttachment,
	replyInThread,
	requeueJob,
	saveChatDraft,
	type ThreadRow,
} from './harness';
import {removeMembership} from './organization';

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

// A turn of the agent's that says `text`, with no calls.
function said(text: string) {
	return {text, toolCalls: [], inputTokens: 1, outputTokens: 1, system: null};
}

describe.skipIf(!databaseUrl)('the harness, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	// The member's chat with General, and the thread the tests below go on in.
	let chat: ThreadRow;
	let thread: ThreadRow;

	// Opens a thread in the chat with what the member says, with the files they attach, which wakes it.
	async function open(
		of: ThreadRow,
		text: string,
		attachments: Parameters<typeof openThread>[4] = [],
	) {
		const task = {
			orgId,
			agentId,
			ownerUserId: userId,
			personaId: of.personaId,
			parentId: null,
			title: text,
			goal: text,
			via: 'harness' as const,
		};
		const opened = unwrap(
			await openThread(of.id, text, {title: text, task}, readyForInference, attachments),
		);
		if (!opened) {
			throw new Error('no chat');
		}
		return opened;
	}

	// What the member replies in the thread, with the files they attach, which wakes it.
	async function reply(text: string, attachments: Parameters<typeof replyInThread>[4] = []) {
		return unwrap(await replyInThread(chat.id, thread.id, text, readyForInference, attachments));
	}

	// The next job due, which must be `threadId`'s, claimed by `workerId`.
	async function claimFor(workerId: string, threadId: string): Promise<ClaimedJob> {
		const job = unwrap(await claimJob(workerId, 60_000));
		if (!job || job.threadId !== threadId) {
			throw new Error(`expected a job of ${threadId}, got ${JSON.stringify(job)}`);
		}
		return job;
	}

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
		chat = unwrap(await ensureMemberChat({orgId, agentId, personaId: persona.id, userId}));
		thread = (await open(chat, 'Find my invoices')).thread;
	});

	// The thread's task as it is now.
	async function taskOf(of: ThreadRow) {
		const now = unwrap(await getJobThread(of.id));
		return db.agentTask.findUniqueOrThrow({where: {id: now?.taskId ?? ''}});
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
						{id: 'c0', name: 'send_to_person', arguments: '{}'},
						{id: 'c1', name: 'script', arguments: '{"code":"return 1"}'},
					],
					inputTokens: 10,
					outputTokens: 2,
					system: 'You are signed in.',
				},
				{
					plans: {
						c0: {kind: 'answer', text: 'Give text, the message.', isError: true},
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
			throw new Error(`expected the script’s tool job, got ${JSON.stringify(tool)}`);
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
				() => ({
					kind: 'end',
					text: 'Something went wrong on my side.',
					end: {outcome: 'Something went wrong on my side.'},
				}),
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

	test('the persona’s last answer is unread until the chat is read up to it, never back, and what the person says after it reads nothing', async () => {
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
					said(text),
					{end: {outcome: text}},
					readyForInference,
				),
			);
			const last = await lastAnswer();
			if (last?.answer.text !== text) {
				throw new Error(`expected the answer ${text}, got ${JSON.stringify(last)}`);
			}
			return last.answer.id;
		};

		await reply('Anything new?');
		const first = await answer('worker-r', 'Nothing new.');
		expect((await lastAnswer())?.unread).toBe(true);

		await reply('And now?');
		expect(await lastAnswer()).toEqual({
			personaId: persona.id,
			personaName: persona.name,
			answer: {id: first, text: 'Nothing new.'},
			unread: true,
		});

		const second = await answer('worker-r2', 'Still nothing.');
		expect(unwrap(await markChatRead(chat.id, first))).toBe(true);
		expect((await lastAnswer())?.unread).toBe(true);

		expect(unwrap(await markChatRead(chat.id, second))).toBe(true);
		expect((await lastAnswer())?.unread).toBe(false);
		expect(unwrap(await markChatRead(chat.id, first))).toBe(true);
		expect((await lastAnswer())?.unread).toBe(false);

		expect(unwrap(await markChatRead(chat.id, 'no-such-entry'))).toBe(false);
		expect(unwrap(await markChatRead('no-such-chat', second))).toBe(false);
		// A thread is no chat to be read.
		expect(unwrap(await markChatRead(thread.id, second))).toBe(false);
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

		const travelChat = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: travel.id, userId}),
		);
		const travelThread = (await open(travelChat, 'Book the train to Lyon.')).thread;
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
		const draftChat = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: drafts.id, userId}),
		);
		const listedDraft = async () =>
			unwrap(await listPersonas(orgId, userId)).find((persona) => persona.id === drafts.id)?.draft;

		expect(unwrap(await getChatDraft(draftChat.id))).toBeNull();
		expect(await listedDraft()).toBeNull();

		expect(unwrap(await saveChatDraft(draftChat.id, 'Pricing review with'))).toBe(true);
		expect(unwrap(await saveChatDraft(draftChat.id, 'Pricing review with Dana'))).toBe(true);
		expect(unwrap(await getChatDraft(draftChat.id))).toBe('Pricing review with Dana');
		expect(await listedDraft()).toBe('Pricing review with Dana');

		expect(unwrap(await saveChatDraft(draftChat.id, null))).toBe(true);
		expect(unwrap(await getChatDraft(draftChat.id))).toBeNull();

		unwrap(await saveChatDraft(draftChat.id, 'Move the pricing review'));
		const sent = (await open(draftChat, 'Move the pricing review')).thread;
		expect(unwrap(await getChatDraft(draftChat.id))).toBeNull();
		expect(unwrap(await saveChatDraft('no-such-chat', 'Hello'))).toBe(false);
		// A thread keeps none.
		expect(unwrap(await saveChatDraft(sent.id, 'Hello'))).toBe(false);

		// The job the message woke is done with, so the tests after this claim only their own.
		const job = await claimFor('worker-dr', sent.id);
		unwrap(await finishJob(job.id, 'worker-dr'));
	});

	test('a finish with nothing written is a done event too', async () => {
		await reply('Try again');
		const job = await claimFor('worker-e', thread.id);
		unwrap(await finishJob(job.id, 'worker-e'));
		const events = unwrap(await listJobEvents(thread.id));
		expect(events.slice(-2).map((event) => [event.jobId, event.kind, event.workerId])).toEqual([
			[job.id, 'claimed', 'worker-e'],
			[job.id, 'done', 'worker-e'],
		]);
		expect(
			await db.agentJob.count({where: {threadId: thread.id, status: {in: ['queued', 'running']}}}),
		).toBe(0);
	});

	test('a reply wakes a thread asleep: the sleep is answered as any wake-up is, and the reply follows it; a job no longer the worker’s writes nothing; a task that ended long ago is taken up as a new one for the same work', async () => {
		await reply('Check again in an hour');
		const turn = await claimFor('worker-f', thread.id);
		const later = new Date(Date.now() + 60 * 60 * 1000);
		unwrap(
			await completeInference(
				turn.id,
				'worker-f',
				thread.id,
				{...said(''), toolCalls: [{id: 'z1', name: 'sleep_until', arguments: '{"seconds":3600}'}]},
				{plans: {z1: {kind: 'job', runAt: later}}},
				readyForInference,
			),
		);
		const sleeping = await db.agentJob.findFirstOrThrow({
			where: {threadId: thread.id, status: 'queued'},
		});
		expect([sleeping.kind, sleeping.callId, sleeping.runAt]).toEqual(['tool', 'z1', later]);

		// The reply has the sleep's job due now, and waits for its answer.
		await reply('Check now instead.');
		const woken = await claimFor('worker-g', thread.id);
		expect(woken.id).toBe(sleeping.id);
		unwrap(
			await completeToolJob(
				woken.id,
				'worker-g',
				thread.id,
				{callId: 'z1', text: 'Woken.', isError: false},
				readyForInference,
			),
		);
		expect(
			unwrap(await listEntries(thread.id))
				.slice(-2)
				.map((entry) => [entry.kind, entry.callId, entry.text]),
		).toEqual([
			['tool_result', 'z1', 'Woken.'],
			['person', null, 'Check now instead.'],
		]);

		// The turn the reply woke: a worker that no longer holds it writes nothing.
		const next = await claimFor('worker-h', thread.id);
		expect(next.kind).toBe('inference');
		expect(
			unwrap(
				await completeInference(
					next.id,
					'worker-z',
					thread.id,
					said('Late.'),
					{end: {outcome: 'Late.'}},
					readyForInference,
				),
			),
		).toBe(false);
		unwrap(
			await completeInference(
				next.id,
				'worker-h',
				thread.id,
				said('Nothing new.'),
				{end: {outcome: 'Nothing new.'}},
				readyForInference,
			),
		);
		const ended = await taskOf(thread);
		expect(ended).toMatchObject({outcome: 'Nothing new.', finishedAt: expect.any(Date)});

		// One that ended more than 20 minutes ago keeps its task finished as it was, and takes a reply
		// up with a new task for the same work.
		const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		await db.agentTask.update({
			where: {id: ended.id},
			data: {finishedAt: anHourAgo, lastActiveAt: anHourAgo},
		});
		await reply('Any from July?');
		const renewed = await taskOf(thread);
		expect(renewed.id).not.toBe(ended.id);
		expect(renewed).toMatchObject({
			title: ended.title,
			goal: ended.goal,
			personaId: thread.personaId,
			finishedAt: null,
			outcome: null,
		});
		expect(await db.agentTask.findUniqueOrThrow({where: {id: ended.id}})).toMatchObject({
			outcome: 'Nothing new.',
			finishedAt: anHourAgo,
		});
		const taken = await claimFor('worker-i', thread.id);
		unwrap(await finishJob(taken.id, 'worker-i'));
	});

	test('what the person attaches lands with what they said, in order, and is the thread’s to read: that version, of that file, for its task alone', async () => {
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

		const withFiles = await reply('What do these say?', [file, picture]);
		await reply('And nothing with this one.');
		// The turn they woke is done with, so the tests after this claim only their own.
		const woken = await claimFor('worker-at', thread.id);
		unwrap(await finishJob(woken.id, 'worker-at'));

		// Versions of no drive here, so gone from it.
		expect(unwrap(await listAttachments(thread.id))).toEqual([
			{...file, entryId: withFiles?.id ?? '', gone: true},
			{...picture, entryId: withFiles?.id ?? '', gone: true},
		]);
		// A version its drive still keeps is not: both are of v1 here.
		const drive = await db.connection.create({
			data: {
				orgId,
				integrationId: 'files',
				account: 'Files',
				credential: null,
				ownerUserId: userId,
			},
		});
		const blob = await db.fileBlob.create({
			data: {orgId, backendId: 'disk', key: `harness-test-${drive.id}`},
		});
		await db.fileVersion.create({
			data: {
				id: file.version,
				connectionId: drive.id,
				fileId: file.fileId,
				blobId: blob.id,
				size: 42,
				type: file.type,
			},
		});
		expect(unwrap(await listAttachments(thread.id)).map((attachment) => attachment.gone)).toEqual([
			false,
			false,
		]);
		await db.fileVersion.delete({where: {id: file.version}});
		await db.fileBlob.delete({where: {id: blob.id}});
		await db.connection.delete({where: {id: drive.id}});

		const task = await taskOf(thread);
		const other = await db.agentTask.create({
			data: {orgId, agentId, title: 'Something else', goal: 'Else', via: 'harness'},
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
		// A task that is no thread's, and one of another organization.
		expect(unwrap(await isAttachedForTask({orgId, taskId: other.id}, attached))).toBe(false);
		expect(unwrap(await isAttachedForTask({orgId: 'another-org', taskId: task.id}, attached))).toBe(
			false,
		);
	});
	test('the files an answer shows land with it, whether written as the turn goes or as it ends, and hand nothing over', async () => {
		const own = await db.agentThread.create({
			data: {
				orgId,
				agentId,
				personaId: thread.personaId,
				userId,
				parentThreadId: chat.id,
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
				{end: {outcome: 'Both: ![Chart](link) ![Sheet](link)'}},
				readyForInference,
			),
		);

		const answers = unwrap(await listEntries(own.id)).filter((entry) => entry.kind === 'assistant');
		expect(unwrap(await listAttachments(own.id))).toEqual([
			{...chart, entryId: answers[0]?.id ?? '', gone: true},
			{...chart, entryId: answers[1]?.id ?? '', gone: true},
			{...sheet, entryId: answers[1]?.id ?? '', gone: true},
		]);

		// What the agent showed lets no agent read it as an attachment would.
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
	test('the files put in a chat’s input wait there in order, each once, up to as many as a message carries, are taken out one at a time, and go with the message that is sent', async () => {
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

		expect(unwrap(await addDraftAttachment(chat.id, notes, 2))).toBe(true);
		expect(unwrap(await addDraftAttachment(chat.id, chart, 2))).toBe(true);
		// The same file at the same version is there once, and a full input takes no more.
		expect(unwrap(await addDraftAttachment(chat.id, notes, 2))).toBe(true);
		const full = await addDraftAttachment(chat.id, file('file-3', 'more.txt'), 2);
		expect(full.isErr() && full.error.kind).toBe('conflict');
		expect(unwrap(await listDraftAttachments(chat.id))).toEqual([notes, chart]);
		const listed = unwrap(await listPersonas(orgId, userId)).find(
			(persona) => persona.id === chat.personaId,
		);
		expect(listed?.draftAttachments).toEqual([notes, chart]);

		// A save of what was typed with the files' order keeps them as they sit among the words,
		// any it doesn't name after them, and adds or drops none.
		expect(unwrap(await saveChatDraft(chat.id, 'See these', [chart, file('file-9', 'x')]))).toBe(
			true,
		);
		expect(unwrap(await listDraftAttachments(chat.id))).toEqual([chart, notes]);
		expect(unwrap(await getChatDraft(chat.id))).toBe('See these');
		expect(unwrap(await saveChatDraft(chat.id, null, [notes]))).toBe(true);
		expect(unwrap(await listDraftAttachments(chat.id))).toEqual([notes, chart]);
		// A file named twice, as a chip copied in the input, keeps where it is named first.
		expect(unwrap(await saveChatDraft(chat.id, null, [chart, notes, chart]))).toBe(true);
		expect(unwrap(await listDraftAttachments(chat.id))).toEqual([chart, notes]);
		expect(unwrap(await saveChatDraft(chat.id, null, [notes]))).toBe(true);

		// What waits in the input is no part of a log, and lets no agent read it.
		expect(unwrap(await listAttachments(chat.id))).toEqual([]);

		expect(unwrap(await removeDraftAttachment(chat.id, notes))).toBe(true);
		expect(unwrap(await listDraftAttachments(chat.id))).toEqual([chart]);
		// A later version of the file is another file to the input.
		expect(unwrap(await removeDraftAttachment(chat.id, {...chart, version: 'v2'}))).toBe(true);
		expect(unwrap(await listDraftAttachments(chat.id))).toEqual([chart]);

		const sent = {...chart, text: null, cut: false};
		const opened = await open(chat, 'Here it is.', [sent]);
		expect(unwrap(await listDraftAttachments(chat.id))).toEqual([]);
		expect(unwrap(await listAttachments(opened.thread.id))).toEqual([
			{...sent, entryId: opened.entry.id, gone: true},
		]);
		// Only a chat keeps an input.
		expect(unwrap(await addDraftAttachment(thread.id, notes, 2))).toBe(false);
		expect(unwrap(await addDraftAttachment('no-such-chat', notes, 2))).toBe(false);
		const job = await claimFor('worker-in', opened.thread.id);
		unwrap(await finishJob(job.id, 'worker-in'));
	});
});
