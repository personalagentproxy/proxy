import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';
import type {ApiError} from '@proxy/utils';
import {DEFAULT_LOOK, readyForInference} from '@proxy/utils/harness';
import {db} from '.';
import {
	appendEntry,
	createPersona,
	ensureMemberChat,
	getChatDraft,
	getChatThread,
	getThreadAgent,
	hasChatThread,
	listChatThreads,
	listAnswers,
	listPersonas,
	lockThread,
	markChatRead,
	openThread,
	replyInThread,
	saveChatDraft,
	type ThreadOpening,
	type ThreadRow,
} from './harness';

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

// Opt-in local integration tests. All records are synthetic and removed afterwards.
describe.skipIf(!process.env.DATABASE_URL)('team conversations', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let orgId = '';
	let agentId = '';
	let ownerId = '';
	let authorId = '';
	let readerId = '';
	let first: ThreadRow;
	let second: ThreadRow;
	let privateChat: ThreadRow;
	let openedId = '';
	beforeAll(async () => {
		const owner = await db.user.create({data: {email: `team-owner-${stamp}@example.test`}});
		ownerId = owner.id;
		authorId = (
			await db.user.create({data: {name: 'Dana', email: `team-author-${stamp}@example.test`}})
		).id;
		readerId = (
			await db.user.create({data: {name: 'Robin', email: `team-reader-${stamp}@example.test`}})
		).id;
		orgId = (
			await db.organization.create({
				data: {name: 'Team tests', slug: `team-${stamp}`, ownerUserId: ownerId},
			})
		).id;
		await db.orgMember.createMany({
			data: [ownerId, authorId, readerId].map((userId) => ({orgId, userId})),
		});
		agentId = (
			await db.agent.create({
				data: {
					orgId,
					providerId: 'proxy',
					name: 'Built in',
					username: `team-${stamp}`,
					passwordHash: '',
				},
			})
		).id;
		const persona = unwrap(
			await createPersona(orgId, authorId, {
				name: 'Team',
				look: DEFAULT_LOOK,
				color: 'blue',
				conversationScope: 'team',
			}),
		);
		first = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: persona.id, userId: authorId}),
		);
		second = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: persona.id, userId: readerId}),
		);
		const personal = unwrap(
			await createPersona(orgId, authorId, {name: 'Private', look: DEFAULT_LOOK, color: 'blue'}),
		);
		privateChat = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: personal.id, userId: authorId}),
		);
	});
	afterAll(async () => {
		await db.organization.deleteMany({where: {id: orgId}});
		await db.user.deleteMany({where: {id: {in: [ownerId, authorId, readerId]}}});
		await db.$disconnect();
	});
	function opening(chat: ThreadRow): ThreadOpening {
		return {
			title: 'Review draft',
			task: {
				orgId,
				agentId,
				ownerUserId: chat.userId,
				personaId: chat.personaId,
				parentId: null,
				title: 'Review draft',
				goal: 'Review a synthetic draft',
				via: 'harness',
			},
		};
	}
	test('members share messages and task state while drafts remain personal', async () => {
		unwrap(await saveChatDraft(first.id, 'Dana draft'));
		unwrap(await saveChatDraft(second.id, 'Robin draft'));
		const opened = unwrap(
			await openThread(first.id, 'Please review', opening(first), readyForInference),
		);
		expect(opened).not.toBeNull();
		if (!opened) {
			return;
		}
		openedId = opened.thread.id;
		expect(opened.thread.userId).toBeNull();
		expect(opened.entry.senderUserId).toBe(authorId);
		expect(opened.entry.senderName).toBe('Dana');
		expect(
			(await db.agentTask.findUniqueOrThrow({where: {id: opened.thread.taskId!}})).ownerUserId,
		).toBeNull();
		const visible = unwrap(await getChatThread(second.id, openedId, []));
		expect(visible?.entries[0]?.text).toBe('Please review');
		expect(unwrap(await listChatThreads(second.id, [])).map((t) => t.id)).toContain(openedId);
		expect(unwrap(await getChatDraft(first.id))).toBeNull();
		expect(unwrap(await getChatDraft(second.id))).toBe('Robin draft');
		const reply = unwrap(await replyInThread(second.id, openedId, 'I can help', readyForInference));
		expect(reply?.senderUserId).toBe(readerId);
		expect(reply?.senderName).toBe('Robin');
		const signedIn = unwrap(await getThreadAgent(opened.thread));
		expect(signedIn?.ownerUserId).toBeNull();
		expect(
			unwrap(await listPersonas(orgId, readerId)).find((p) => p.id === first.personaId)?.lastMessage
				?.text,
		).toBe('I can help');
	});
	test('personal histories cannot be reached through a team root', async () => {
		const opened = unwrap(
			await openThread(privateChat.id, 'Private request', opening(privateChat), readyForInference),
		);
		if (!opened) {
			throw new Error('No private thread');
		}
		expect(unwrap(await hasChatThread(second.id, opened.thread.id))).toBe(false);
		expect(unwrap(await getChatThread(second.id, opened.thread.id, []))).toBeNull();
		expect(
			unwrap(await replyInThread(second.id, opened.thread.id, 'Unauthorized', readyForInference)),
		).toBeNull();
	});
	test('read progress is personal although answers are shared', async () => {
		const answer = await db.$transaction(async (tx) => {
			const thread = await lockThread(tx, openedId);
			if (!thread) {
				throw new Error('Missing shared thread');
			}
			return appendEntry(tx, thread, {kind: 'assistant', text: 'Review complete'}, () => false);
		});
		expect(unwrap(await markChatRead(first.id, answer.id))).toBe(true);
		expect(
			unwrap(await listAnswers(orgId, authorId)).find((a) => a.personaId === first.personaId)
				?.unread,
		).toBe(false);
		expect(
			unwrap(await listAnswers(orgId, readerId)).find((a) => a.personaId === first.personaId)
				?.unread,
		).toBe(true);
	});
	test('shared history and execution survive deletion of the original author', async () => {
		await db.user.delete({where: {id: authorId}});
		const visible = unwrap(await getChatThread(second.id, openedId, []));
		expect(visible?.entries[0]?.senderName).toBe('Dana');
		const reply = unwrap(
			await replyInThread(second.id, openedId, 'Continue review', readyForInference),
		);
		expect(reply?.senderUserId).toBe(readerId);
		const locked = await db.$transaction((tx) => lockThread(tx, openedId));
		expect(locked?.id).toBe(openedId);
	});
});
