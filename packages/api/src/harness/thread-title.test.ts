import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';
import type {ChatThreadRow, EntryRow, ShownEntryRow, ThreadRow} from '@proxy/db/harness';

import {log} from '../observability/log';
import {type FakeStore, fakeStore} from './fake-store';
import {cleanTitle, TITLE_INSTRUCTIONS, titleAtTurn, type TitleModel, titleThreadsWithoutTitle, writeTitle} from './thread-title';

const now = new Date('2026-03-02T09:00:00Z');

// A thread of the member's chat, as the worker finds it by its id, named by a line of its message.
const row: ThreadRow = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'login-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: 'chat-1',
	subAgentOfId: null,
	parentCallId: null,
	title: 'book a table for 4 near the office thursday 7pm, somewhere quiet',
	taskId: 'task-1',
	harness: null,
	harnessSession: null,
	openedByAlert: false,
	createdAt: now,
};

// An entry of the log, as the store gives it.
function logEntry(entry: Pick<EntryRow, 'id' | 'seq' | 'kind' | 'text'> & Partial<EntryRow & ShownEntryRow>): EntryRow & ShownEntryRow {
	return {
		threadId: 'thread-1',
		pending: false,
		toolCalls: null,
		callId: null,
		isError: false,
		inputTokens: null,
		outputTokens: null,
		coversSeq: null,
		system: null,
		harness: null,
		model: null,
		jobId: null,
		passedOnFromId: null,
		passedOn: null,
		createdAt: now,
		...entry,
	};
}

// The thread just opened, as the member sees it: what they said, with a file, its agent at work.
function chatThread(thread: Partial<ChatThreadRow> = {}): ChatThreadRow {
	return {
		...row,
		state: {kind: 'working'},
		standing: {waitingForMember: false, summary: null, summarySeq: null, archived: false},
		alerts: 0,
		entries: [logEntry({id: 'e1', seq: 1, kind: 'person', text: `book a table for 4 near the office thursday 7pm, somewhere quiet ${ATTACHMENT_MARK}`})],
		subAgents: [],
		attachments: [{entryId: 'e1', connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'places.md', type: 'text/markdown', size: 12, text: '', cut: false, gone: false}],
		...thread,
	};
}

let store: FakeStore;
let ask: ReturnType<typeof mock<TitleModel['ask']>>;
let model: TitleModel;

beforeEach(() => {
	store = fakeStore();
	store.threadNeedsTitle.mockResolvedValue(Ok(true));
	store.getJobThread.mockResolvedValue(Ok(row));
	store.getShownThread.mockResolvedValue(Ok(chatThread()));
	store.writeThreadTitle.mockResolvedValue(Ok(true));
	ask = mock<TitleModel['ask']>(async () => Ok({title: ' "Thursday dinner for four." '}));
	model = {key: 'sk-or-1', ask};
});

describe('a thread’s title', () => {
	test('asks the small model on the key, with what the member sees of the thread, and writes the title it gives, as a title', async () => {
		expect((await writeTitle(store, model, 'thread-1', () => now)).unwrap()).toBe('written');

		expect(store.getShownThread).toHaveBeenCalledWith('thread-1', ['send_to_person'], now);
		expect(ask).toHaveBeenCalledTimes(1);
		const request = ask.mock.calls[0]?.[0];
		expect(request).toMatchObject({key: 'sk-or-1', system: TITLE_INSTRUCTIONS, name: 'title', timeoutMs: 10_000});
		expect(request?.user).toBe('Person: book a table for 4 near the office thursday 7pm, somewhere quiet [attached: places.md]');
		expect(store.writeThreadTitle).toHaveBeenCalledWith('thread-1', 'Thursday dinner for four');
	});

	test('without the key, asks nothing and writes nothing: the thread keeps the line of its message', async () => {
		expect((await writeTitle(store, {key: undefined, ask}, 'thread-1')).unwrap()).toBe('skipped');
		await titleAtTurn(store, {key: undefined, ask}, 'thread-1');
		expect(store.threadNeedsTitle).not.toHaveBeenCalled();
		expect(ask).not.toHaveBeenCalled();
		expect(store.writeThreadTitle).not.toHaveBeenCalled();
	});

	test('asks nothing for a thread named already, a chat, one that is gone, or one with nothing said in it', async () => {
		store.threadNeedsTitle.mockResolvedValueOnce(Ok(false));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getJobThread.mockResolvedValueOnce(Ok({...row, parentThreadId: null}));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getJobThread.mockResolvedValueOnce(Ok(null));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getShownThread.mockResolvedValueOnce(Ok(null));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getShownThread.mockResolvedValueOnce(Ok(chatThread({entries: [], attachments: []})));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		expect(ask).not.toHaveBeenCalled();
		expect(store.writeThreadTitle).not.toHaveBeenCalled();
	});

	test('a title with no words leaves the line of the message, and one written meanwhile is left as it is', async () => {
		ask.mockResolvedValueOnce(Ok({title: ' "" '}));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
		expect(store.writeThreadTitle).not.toHaveBeenCalled();

		store.writeThreadTitle.mockResolvedValueOnce(Ok(false));
		expect((await writeTitle(store, model, 'thread-1')).unwrap()).toBe('skipped');
	});

	test('is kept on one line, without quotes or a period around it, an ellipsis or a version left whole, and cut', () => {
		expect(cleanTitle('  “Pricing review\n decisions”  ')).toBe('Pricing review decisions');
		expect(cleanTitle('Merge #412.')).toBe('Merge #412');
		expect(cleanTitle('Waiting on the bank...')).toBe('Waiting on the bank...');
		expect(cleanTitle('Bump vite to 8.4')).toBe('Bump vite to 8.4');
		expect(cleanTitle('a'.repeat(100))).toHaveLength(80);
	});

	test('as a turn starts, a failure is logged and asked once more, and never thrown', async () => {
		const warn = spyOn(log, 'warn').mockImplementation(() => {});
		ask.mockResolvedValueOnce(Err(ApiErr.providerUnreachable(new Error('down'))));
		await titleAtTurn(store, {...model, retryMs: 1}, 'thread-1');
		expect(ask).toHaveBeenCalledTimes(2);
		expect(store.writeThreadTitle).toHaveBeenCalledWith('thread-1', 'Thursday dinner for four');
		expect(warn).toHaveBeenCalledTimes(1);

		// Failing both times, the thread keeps its line.
		ask.mockClear();
		store.writeThreadTitle.mockClear();
		ask.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));
		await titleAtTurn(store, {...model, retryMs: 1}, 'thread-1');
		expect(ask).toHaveBeenCalledTimes(2);
		expect(store.writeThreadTitle).not.toHaveBeenCalled();

		// No answer in time is a failure too.
		ask.mockClear();
		ask.mockImplementation(() => new Promise(() => {}));
		await titleAtTurn(store, {...model, timeoutMs: 5, retryMs: 1}, 'thread-1');
		expect(ask).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	test('the threads from before are named one after another, the oldest first, a failure counted and the rest named', async () => {
		const warn = spyOn(log, 'warn').mockImplementation(() => {});
		store.listThreadsWithoutTitle.mockResolvedValue(Ok([{id: 'thread-1'}, {id: 'thread-2'}, {id: 'thread-3'}]));
		store.threadNeedsTitle.mockImplementation(async (threadId) => Ok(threadId !== 'thread-3'));
		ask.mockResolvedValueOnce(Err(ApiErr.providerUnreachable(new Error('down'))));
		const heard: string[] = [];

		const counts = (await titleThreadsWithoutTitle(store, model, (threadId, outcome) => heard.push(`${threadId}:${outcome}`))).unwrap();

		expect(counts).toEqual({written: 1, skipped: 1, failed: 1});
		expect(heard).toEqual(['thread-1:failed', 'thread-2:written', 'thread-3:skipped']);
		warn.mockRestore();
	});
});
