import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {ChatThreadRow, ThreadRow} from '@proxy/db/harness';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';

import {type FakeStore, fakeStore} from './fake-store';
import {TITLE_INSTRUCTIONS, type TitleModel, titleAtStart, writeTitle} from './thread-title';

const now = new Date('2026-10-21T10:00:00Z');
const said = `can you look into how i renew my passport, it runs out in february i think ${ATTACHMENT_MARK}`;

// A thread of the member's chat, its message just sent, its first turn starting.
const row: ThreadRow = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: 'chat-1',
	title: 'can you look into how i renew my passport, it runs out in february i think',
	taskId: 'task-1',
	harness: null,
	harnessSession: null,
	createdAt: now,
};

function chatThread(over: Partial<ChatThreadRow> = {}): ChatThreadRow {
	return {
		...row,
		startedFromThreadId: null,
		titleWritten: false,
		state: {kind: 'working'},
		standing: {waitingForMember: false, summary: null, summarySeq: null, archived: false},
		entries: [{id: 'e1', seq: 1, kind: 'person', text: said, pending: false, toolCalls: null, isError: false, createdAt: now}],
		attachments: [{entryId: 'e1', gone: false, connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'passport.pdf', type: 'application/pdf', size: 42, text: null, cut: false}],
		...over,
	};
}

let store: FakeStore;
let ask: ReturnType<typeof mock<TitleModel['ask']>>;
let model: TitleModel;

beforeEach(() => {
	store = fakeStore();
	store.getJobThread.mockResolvedValue(Ok(row));
	store.getChatThread.mockResolvedValue(Ok(chatThread()));
	store.writeThreadTitle.mockResolvedValue(Ok(true));
	ask = mock<TitleModel['ask']>(async () => Ok({title: ' “Renew the passport before February.” '}));
	model = {key: 'sk-or-1', ask, timeoutMs: 50, retryMs: 1};
});

describe('a thread’s title', () => {
	test('is written from the message that opened it, with the names of its files, as a few words without quotes or a period', async () => {
		expect((await writeTitle(store, model, 'thread-1', () => now)).unwrap()).toBe('written');

		expect(ask).toHaveBeenCalledTimes(1);
		const request = ask.mock.calls[0]?.[0];
		expect(request?.system).toBe(TITLE_INSTRUCTIONS);
		expect(request?.user).toBe('can you look into how i renew my passport, it runs out in february i think\n\n[attached: passport.pdf]');
		expect(store.writeThreadTitle).toHaveBeenCalledWith('thread-1', 'Renew the passport before February');
	});

	test('is asked for nothing without the key, for a thread that has one, or one an alert opened', async () => {
		expect((await writeTitle(store, {...model, key: undefined}, 'thread-1')).unwrap()).toBe('skipped');
		store.getChatThread.mockResolvedValue(Ok(chatThread({titleWritten: true})));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getChatThread.mockResolvedValue(
			Ok(chatThread({entries: [{id: 'e1', seq: 1, kind: 'event', text: 'Every weekday at 9:00', pending: false, toolCalls: null, isError: false, createdAt: now}]})),
		);
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		expect(ask).not.toHaveBeenCalled();
		expect(store.writeThreadTitle).not.toHaveBeenCalled();
	});

	test('as a first turn starts, is tried once more where the model fails, and never throws', async () => {
		ask.mockImplementationOnce(() => new Promise(() => {}));
		await titleAtStart(store, model, 'thread-1');
		expect(ask).toHaveBeenCalledTimes(2);
		expect(store.writeThreadTitle).toHaveBeenCalledTimes(1);

		store.getJobThread.mockRejectedValue(new Error('the database is gone'));
		await titleAtStart(store, model, 'thread-1');
	});
});
