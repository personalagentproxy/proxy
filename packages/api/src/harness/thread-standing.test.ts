import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';
import type {ChatThreadRow, EntryRow, ThreadRow} from '@proxy/db/harness';

import {log} from '../observability/log';
import {type FakeStore, fakeStore} from './fake-store';
import {STANDING_INSTRUCTIONS, type StandingModel, standAfterTurn, summarizeThreadsWithoutSummary, threadForModel, writeStanding} from './thread-standing';

const now = new Date('2026-03-02T09:00:00Z');

// A thread of the member's chat, as the worker finds it by its id.
const row: ThreadRow = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'login-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: 'chat-1',
	title: 'Add a date filter to the activity log',
	taskId: 'task-1',
	harness: null,
	harnessSession: null,
	createdAt: now,
};

// An entry of the log, as the store gives it.
function logEntry(entry: Pick<EntryRow, 'id' | 'seq' | 'kind' | 'text'> & Partial<EntryRow>): EntryRow {
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
		createdAt: now,
		...entry,
	};
}

// The thread as the member sees it: they asked, the agent answered with a question; stopped, with
// no summary yet.
function chatThread(thread: Partial<ChatThreadRow> = {}): ChatThreadRow {
	return {
		...row,
		state: {kind: 'stopped'},
		standing: {waitingForMember: false, summary: null, summarySeq: null},
		entries: [
			logEntry({id: 'e1', seq: 1, kind: 'person', text: `Add a date filter to the activity log, plan first ${ATTACHMENT_MARK}`}),
			logEntry({
				id: 'e2',
				seq: 2,
				kind: 'assistant',
				text: '',
				toolCalls: [
					{id: 'c1', name: 'send_to_person', arguments: JSON.stringify({text: 'Reading the filter bar first.'})},
					{id: 'c2', name: 'script', arguments: JSON.stringify({code: 'return 1'})},
				],
			}),
			logEntry({id: 'e4', seq: 4, kind: 'assistant', text: 'I have a plan. Should the date range cover the CSV export too?'}),
		],
		attachments: [{entryId: 'e1', connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'filters.md', type: 'text/markdown', size: 12, text: '', cut: false, gone: false}],
		...thread,
	};
}

const answer = {summary: ' Has a plan, and asks whether the date range should cover the CSV export too. ', waitingForMember: true};

let store: FakeStore;
let ask: ReturnType<typeof mock<StandingModel['ask']>>;
let model: StandingModel;

beforeEach(() => {
	store = fakeStore();
	store.getJobThread.mockResolvedValue(Ok(row));
	store.getChatThread.mockResolvedValue(Ok(chatThread()));
	store.writeThreadStanding.mockResolvedValue(Ok(true));
	ask = mock<StandingModel['ask']>(async () => Ok(answer));
	model = {key: 'sk-or-1', ask};
});

describe('where a thread stands, as its turn ends', () => {
	test('asks the small model on the key, with what the member sees of the thread, and writes the sentence and whether it waits, up to the last thing said', async () => {
		expect((await writeStanding(store, model, 'thread-1', true, () => now)).unwrap()).toBe('written');

		expect(store.getChatThread).toHaveBeenCalledWith('chat-1', 'thread-1', ['send_to_person'], now);
		expect(ask).toHaveBeenCalledTimes(1);
		const request = ask.mock.calls[0]?.[0];
		expect(request).toMatchObject({key: 'sk-or-1', system: STANDING_INSTRUCTIONS, name: 'standing', timeoutMs: 20_000});
		// What the person said, with the names of their files; what the agent told them as it went
		// and answered; not the calls it worked through.
		expect(request?.user).toBe(
			[
				'Person: Add a date filter to the activity log, plan first [attached: filters.md]',
				'Agent: Reading the filter bar first.',
				'Agent: I have a plan. Should the date range cover the CSV export too?',
			].join('\n\n'),
		);
		expect(store.writeThreadStanding).toHaveBeenCalledWith('thread-1', {summary: 'Has a plan, and asks whether the date range should cover the CSV export too.', waitingForMember: true}, 4);
	});

	test('without the key, asks nothing and writes nothing: the thread is done, with no summary', async () => {
		expect((await writeStanding(store, {key: undefined, ask}, 'thread-1')).unwrap()).toBe('skipped');
		expect(store.getJobThread).not.toHaveBeenCalled();
		expect(ask).not.toHaveBeenCalled();
		expect(store.writeThreadStanding).not.toHaveBeenCalled();
	});

	test('asks nothing for a thread at work or asleep, one the member has a reply pending in, a chat, or one whose summary is current', async () => {
		store.getChatThread.mockResolvedValueOnce(Ok(chatThread({state: {kind: 'working'}})));
		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getChatThread.mockResolvedValueOnce(Ok(chatThread({state: {kind: 'asleep', until: now}})));
		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getChatThread.mockResolvedValueOnce(Ok(chatThread({entries: [...chatThread().entries, logEntry({id: 'e5', seq: 5, kind: 'person', text: 'Yes, include it', pending: true})]})));
		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getChatThread.mockResolvedValueOnce(Ok(chatThread({standing: {waitingForMember: true, summary: 'Has a plan.', summarySeq: 4}})));
		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getJobThread.mockResolvedValueOnce(Ok({...row, parentThreadId: null}));
		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('skipped');
		store.getJobThread.mockResolvedValueOnce(Ok(null));
		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('skipped');
		expect(ask).not.toHaveBeenCalled();
		expect(store.writeThreadStanding).not.toHaveBeenCalled();
	});

	test('writes again once a reply made the summary stale and the turn it began has ended', async () => {
		const replied = chatThread({
			standing: {waitingForMember: false, summary: 'Has a plan.', summarySeq: 4},
			entries: [
				...chatThread().entries,
				logEntry({id: 'e5', seq: 5, kind: 'person', text: 'Yes, include it'}),
				logEntry({id: 'e6', seq: 8, kind: 'assistant', text: 'Added the date range, CSV export included.'}),
			],
		});
		store.getChatThread.mockResolvedValue(Ok(replied));
		ask.mockResolvedValue(Ok({summary: 'Added the date range, CSV export included.', waitingForMember: false}));

		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('written');
		expect(store.writeThreadStanding).toHaveBeenCalledWith('thread-1', {summary: 'Added the date range, CSV export included.', waitingForMember: false}, 8);
	});

	test('where something came in while the model read, the store writes nothing, and nothing is written', async () => {
		store.writeThreadStanding.mockResolvedValue(Ok(false));
		expect((await writeStanding(store, model, 'thread-1')).unwrap()).toBe('skipped');
	});

	test('an empty sentence is no summary; one too long is cut', async () => {
		ask.mockResolvedValueOnce(Ok({summary: '  ', waitingForMember: false}));
		await writeStanding(store, model, 'thread-1');
		expect(store.writeThreadStanding).toHaveBeenLastCalledWith('thread-1', {summary: null, waitingForMember: false}, 4);

		ask.mockResolvedValueOnce(Ok({summary: 'word '.repeat(100), waitingForMember: false}));
		await writeStanding(store, model, 'thread-1');
		expect(store.writeThreadStanding.mock.calls.at(-1)?.[1].summary).toHaveLength(300);
	});

	test('after a turn, a failure of the model, an answer late or a throw is logged, and the model asked once more, a moment later: what it then gives is written', async () => {
		const warn = spyOn(log, 'warn').mockImplementation(() => {});
		const quick = {...model, retryMs: 1};

		ask.mockResolvedValueOnce(Err(ApiErr.providerUnreachable(new Error('The model answered outside the form: {'))));
		expect(await standAfterTurn(store, quick, 'thread-1')).toBeUndefined();
		expect(ask).toHaveBeenCalledTimes(2);
		expect(store.writeThreadStanding).toHaveBeenCalledTimes(1);

		ask.mockImplementationOnce(() => new Promise(() => {}));
		expect(await standAfterTurn(store, {...quick, timeoutMs: 20}, 'thread-1')).toBeUndefined();
		expect(store.writeThreadStanding).toHaveBeenCalledTimes(2);

		ask.mockRejectedValueOnce(new Error('boom'));
		expect(await standAfterTurn(store, quick, 'thread-1')).toBeUndefined();
		expect(store.writeThreadStanding).toHaveBeenCalledTimes(3);

		store.getChatThread.mockResolvedValueOnce(Err(ApiErr.internalError(new Error('database down'))));
		expect(await standAfterTurn(store, quick, 'thread-1')).toBeUndefined();
		expect(store.writeThreadStanding).toHaveBeenCalledTimes(4);

		expect(warn).toHaveBeenCalledTimes(4);
		expect(warn.mock.calls.map((call) => call[1])).toEqual(Array.from({length: 4}, () => expect.objectContaining({threadId: 'thread-1', attempt: 1})));
		warn.mockRestore();
	});

	test('after a turn, failing a second time writes nothing, is asked no more, and never fails', async () => {
		const warn = spyOn(log, 'warn').mockImplementation(() => {});
		ask.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('The model answered outside the form: {'))));

		const started = Date.now();
		expect(await standAfterTurn(store, {...model, retryMs: 1}, 'thread-1')).toBeUndefined();

		expect(Date.now() - started).toBeLessThan(1000);
		expect(ask).toHaveBeenCalledTimes(2);
		expect(store.writeThreadStanding).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});
});

describe('the thread as the model reads it', () => {
	test('keeps what opened it and the newest messages that fit, saying how many between are left out', () => {
		const long = 'x'.repeat(2_900);
		const entries = [
			logEntry({id: 'e1', seq: 1, kind: 'person', text: 'Look into why the nightly backup failed'}),
			...Array.from({length: 8}, (_, index) => logEntry({id: `a${index}`, seq: index + 2, kind: 'assistant', text: `${index} ${long}`})),
			logEntry({id: 'e10', seq: 10, kind: 'event', text: 'The alert “backup” came.'}),
		];

		const read = threadForModel(chatThread({entries, attachments: []}));

		expect(read.startsWith('Person: Look into why the nightly backup failed\n\n(3 earlier messages left out)\n\nAgent: 3 ')).toBe(true);
		expect(read.endsWith('Alert: The alert “backup” came.')).toBe(true);
		expect(read.length).toBeLessThanOrEqual(16_000 + 100);
		// A failed answer says so; one message is cut to a length.
		const failed = threadForModel(chatThread({entries: [logEntry({id: 'e1', seq: 1, kind: 'assistant', text: 'y'.repeat(5_000), isError: true})], attachments: []}));
		expect(failed).toBe(`Agent (failed): ${'y'.repeat(2_999)}…`);
	});
});

describe('the summaries of threads from before', () => {
	test('writes one for each thread without, the oldest first, leaving whether it waits as it is, and goes on past one that fails', async () => {
		const warn = spyOn(log, 'warn').mockImplementation(() => {});
		store.listThreadsWithoutSummary.mockResolvedValue(
			Ok([
				{id: 'thread-1', chatId: 'chat-1'},
				{id: 'thread-2', chatId: 'chat-1'},
				{id: 'thread-3', chatId: 'chat-1'},
			]),
		);
		store.getChatThread.mockImplementation(async (_chatId, threadId) => Ok(chatThread({id: threadId, state: threadId === 'thread-3' ? {kind: 'working'} : {kind: 'stopped'}})));
		ask.mockResolvedValueOnce(Ok(answer)).mockResolvedValueOnce(Err(ApiErr.providerUnreachable(new Error('timeout'))));
		const heard: string[] = [];

		const counts = (await summarizeThreadsWithoutSummary(store, model, (threadId, outcome) => heard.push(`${threadId} ${outcome}`))).unwrap();

		expect(counts).toEqual({written: 1, skipped: 1, failed: 1});
		expect(heard).toEqual(['thread-1 written', 'thread-2 failed', 'thread-3 skipped']);
		expect(store.writeThreadStanding).toHaveBeenCalledTimes(1);
		expect(store.writeThreadStanding).toHaveBeenCalledWith('thread-1', {summary: 'Has a plan, and asks whether the date range should cover the CSV export too.'}, 4);
		warn.mockRestore();
	});
});
