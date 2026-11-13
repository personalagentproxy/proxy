import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {fakeHarness} from '@proxy/backends/harness/fake';
import {ApiErr, type ApiError} from '@proxy/utils';
import type {ClaimedJob, JobRow} from '@proxy/db/harness';

import type {Harnesses} from '../backends/harness';
import {type FakeStore, fakeStore} from './fake-store';
import type {StandingModel} from './thread-standing';

type Run = (store: FakeStore, job: JobRow, workerId: string) => Promise<Result<void, ApiError>>;
type RunTurn = (store: FakeStore, harnesses: Harnesses, job: JobRow, workerId: string, woken: boolean) => Promise<Result<void, ApiError>>;

const runInference = mock<RunTurn>(async () => Ok(undefined));
mock.module('./inference', () => ({runInference}));

const runToolJob = mock<Run>(async () => Ok(undefined));
mock.module('./tool-job', () => ({runToolJob}));

const harness: Harnesses = {
	registry: {proxy: fakeHarness(), claudeAgentSdk: null},
	credentials: {claudeCredentialFor: async () => Ok(null), markRefused: async () => Ok(undefined), recordUsage: async () => Ok(undefined)},
};
const now = new Date();
const inference: JobRow = {id: 'j1', threadId: 't1', kind: 'inference', status: 'running', entryId: null, callId: null, runAt: now, claimedBy: 'w', attempts: 1};
const tool: JobRow = {...inference, id: 'j2', kind: 'tool', entryId: 'e1', callId: 'c1'};
const wake: JobRow = {...inference, id: 'j5', kind: 'wake'};
// A job as the queue hands it over: not a turn on the capped harness, unless said.
const claimed = (job: JobRow, capped = false): ClaimedJob => ({...job, capped});

// Waits for the worker to get through what is queued.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let store: FakeStore;

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	store.failJob.mockResolvedValue(Ok(true));
	store.renewLease.mockResolvedValue(Ok(true));
});

describe('the worker', () => {
	test('claims jobs one after another and runs each by its kind, on the store and the harnesses, then stops claiming', async () => {
		const {startHarnessWorker} = await import('./worker');
		store.claimJob
			.mockResolvedValueOnce(Ok(claimed(inference)))
			.mockResolvedValueOnce(Ok(claimed(tool)))
			.mockResolvedValueOnce(Ok(claimed(wake)))
			.mockResolvedValue(Ok(null));

		const worker = startHarnessWorker(store, harness);
		await settle();
		await worker.stop();
		const claims = store.claimJob.mock.calls.length;
		await settle();

		expect(runInference).toHaveBeenCalledWith(store, expect.objectContaining(harness), inference, expect.any(String), false);
		expect(runToolJob).toHaveBeenCalledWith(store, tool, expect.any(String));
		// A wake-up after a sleep is a turn too, the harness told it is one.
		expect(runInference).toHaveBeenCalledWith(store, expect.objectContaining(harness), wake, expect.any(String), true);
		expect(runInference.mock.calls[0]?.[3]).toBe(runToolJob.mock.calls[0]?.[2]);
		expect(store.claimJob.mock.calls.length).toBe(claims);
		// A server without the SDK harness has no cap to keep: every claim is for any job.
		expect(store.claimJob.mock.calls.every((call) => call[2] === null)).toBe(true);
	});

	test('at the cap on turns on the SDK harness, claims only the other jobs until one of those turns ends, so a turn it has no room for stays in the queue', async () => {
		const {startHarnessWorker} = await import('./worker');
		const capped: Harnesses = {...harness, registry: {proxy: fakeHarness(), claudeAgentSdk: {...fakeHarness('claude-agent-sdk'), maxConcurrentTurns: 1}}};
		let end = (): void => {};
		runInference.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					end = () => resolve(Ok(undefined));
				}),
		);
		store.claimJob
			.mockResolvedValueOnce(Ok(claimed(inference, true)))
			.mockResolvedValueOnce(Ok(claimed(tool)))
			.mockResolvedValue(Ok(null));

		const worker = startHarnessWorker(store, capped);
		await settle();
		const during = store.claimJob.mock.calls.map((call) => call[2]);
		end();
		await new Promise((resolve) => setTimeout(resolve, 700));
		await worker.stop();

		// The first claim is for any job; with the turn running, every claim after leaves such turns be.
		expect(during[0]).toEqual({harness: 'claude-agent-sdk', full: false});
		expect(during.length).toBeGreaterThan(1);
		expect(during.slice(1).every((capped) => capped?.full === true)).toBe(true);
		// The tool job ran beside the turn, and the job as the turn was given it is the queue's row alone.
		expect(runToolJob).toHaveBeenCalledWith(store, tool, expect.any(String));
		expect(runInference).toHaveBeenCalledWith(store, expect.objectContaining(capped), inference, expect.any(String), false);
		// Once the turn has ended, there is room for one again.
		expect(store.claimJob.mock.calls.at(-1)?.[2]).toEqual({harness: 'claude-agent-sdk', full: false});
	});

	test('a job that fails, or throws, is marked failed with why, and one claimed too often is given up', async () => {
		const {startHarnessWorker} = await import('./worker');
		runInference.mockResolvedValueOnce(Err(ApiErr.conflict('no longer mine'))).mockResolvedValueOnce(Err(ApiErr.internalError(new Error('OpenRouter refused the request (400): too long'))));
		runToolJob.mockRejectedValueOnce(new Error('boom'));
		store.claimJob
			.mockResolvedValueOnce(Ok(claimed(inference)))
			.mockResolvedValueOnce(Ok(claimed(tool)))
			.mockResolvedValueOnce(Ok(claimed({...inference, id: 'j3', attempts: 5})))
			.mockResolvedValueOnce(Ok(claimed({...inference, id: 'j4'})))
			.mockResolvedValue(Ok(null));

		const worker = startHarnessWorker(store, harness);
		await settle();
		await worker.stop();

		// With what the failure leaves in the thread (thread-rules.test.ts).
		expect(store.failJob).toHaveBeenCalledWith('j1', expect.any(String), 'no longer mine', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j2', expect.any(String), 'boom', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j3', expect.any(String), 'Given up after 4 attempts', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j4', expect.any(String), 'OpenRouter refused the request (400): too long', expect.any(Function));
		expect(runInference).toHaveBeenCalledTimes(2);

		const noteFor = store.failJob.mock.calls.find((call) => call[0] === 'j2')?.[3];
		expect(noteFor?.(tool)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: boom'});
	});

	test('as a turn’s job ends, done or failed, where the thread stands is read after it, and the job is what it was however that goes', async () => {
		const {startHarnessWorker} = await import('./worker');
		runInference.mockResolvedValueOnce(Ok(undefined)).mockResolvedValueOnce(Err(ApiErr.internalError(new Error('OpenRouter refused the request (400): too long'))));
		store.claimJob
			.mockResolvedValueOnce(Ok(claimed(inference)))
			.mockResolvedValueOnce(Ok(claimed(tool)))
			.mockResolvedValueOnce(Ok(claimed({...inference, id: 'j3', threadId: 't3'})))
			.mockResolvedValueOnce(Ok(claimed({...wake, threadId: 't5'})))
			.mockResolvedValue(Ok(null));
		// The model on the key never answers: the worker goes on to the next job all the same, and
		// each reading gives up in its time, asked once more.
		const ask = mock<StandingModel['ask']>(() => new Promise(() => {}));
		const row = (threadId: string) => ({
			id: threadId,
			orgId: 'org-1',
			agentId: 'login-1',
			personaId: 'persona-1',
			userId: 'user-1',
			parentThreadId: 'chat-1',
			title: 'Pricing review with Dana',
			taskId: null,
			harness: null,
			harnessSession: null,
			createdAt: now,
		});
		const said = {
			id: 'e1',
			seq: 1,
			threadId: 't1',
			kind: 'person' as const,
			text: 'Find the pricing review with Dana',
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
		};
		store.getJobThread.mockImplementation(async (threadId) => Ok(row(threadId)));
		store.getChatThread.mockImplementation(async (_chatId, threadId) =>
			Ok({...row(threadId), state: {kind: 'stopped'}, standing: {waitingForMember: false, summary: null, summarySeq: null}, entries: [said], attachments: []}),
		);

		const worker = startHarnessWorker(store, harness, {key: 'sk-or-1', ask, timeoutMs: 20, retryMs: 1});
		await settle();
		// The jobs are done while the model is still being waited for.
		expect(runInference).toHaveBeenCalledTimes(3);
		expect(runToolJob).toHaveBeenCalledTimes(1);
		await worker.stop();

		// Each turn's thread, the failed one's too, after its job; not a tool job's.
		expect([...new Set(store.getJobThread.mock.calls.map((call) => call[0]))].toSorted()).toEqual(['t1', 't3', 't5']);
		expect(store.failJob).toHaveBeenCalledTimes(1);
		expect(store.failJob).toHaveBeenCalledWith('j3', expect.any(String), 'OpenRouter refused the request (400): too long', expect.any(Function));
		expect(ask).toHaveBeenCalledTimes(6);
		expect(store.writeThreadStanding).not.toHaveBeenCalled();
	});

	test('stopping, the worker waits for where a thread stands to be written, begun as its turn’s job ended', async () => {
		const {startHarnessWorker} = await import('./worker');
		store.claimJob.mockResolvedValueOnce(Ok(claimed(inference))).mockResolvedValue(Ok(null));
		// The turn takes a moment, and the model one after it: the worker is stopped during the turn.
		runInference.mockImplementationOnce(async () => {
			await settle();
			return Ok(undefined);
		});
		let written = false;
		const model: StandingModel = {key: 'sk-or-1', ask: mock<StandingModel['ask']>(async () => Ok({summary: 'Moved it to Friday.', waitingForMember: false}))};
		store.getJobThread.mockResolvedValue(
			Ok({
				id: 't1',
				orgId: 'org-1',
				agentId: 'login-1',
				personaId: 'persona-1',
				userId: 'user-1',
				parentThreadId: 'chat-1',
				title: null,
				taskId: null,
				harness: null,
				harnessSession: null,
				createdAt: now,
			}),
		);
		store.getChatThread.mockImplementation(async (_chatId, threadId) => {
			await settle();
			return Ok({
				id: threadId,
				orgId: 'org-1',
				agentId: 'login-1',
				personaId: 'persona-1',
				userId: 'user-1',
				parentThreadId: 'chat-1',
				title: null,
				taskId: null,
				harness: null,
				harnessSession: null,
				createdAt: now,
				state: {kind: 'stopped'},
				standing: {waitingForMember: false, summary: null, summarySeq: null},
				entries: [{id: 'e1', seq: 1, kind: 'person', text: 'Move the pricing review', pending: false, toolCalls: null, isError: false, createdAt: now}],
				attachments: [],
			});
		});
		store.writeThreadStanding.mockImplementation(async () => {
			written = true;
			return Ok(true);
		});

		const worker = startHarnessWorker(store, harness, model);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await worker.stop();

		expect(written).toBe(true);
		expect(store.writeThreadStanding).toHaveBeenCalledWith('t1', {summary: 'Moved it to Friday.', waitingForMember: false}, 1, false);
	});

	test('as a turn says its agent told the member something and went on, where the thread stands is written while the turn’s job still runs', async () => {
		const {startHarnessWorker} = await import('./worker');
		store.claimJob.mockResolvedValueOnce(Ok(claimed(inference))).mockResolvedValue(Ok(null));
		let turnOver = false;
		let writtenDuringTurn = false;
		// The turn tells the member something, then goes on for a while.
		runInference.mockImplementationOnce(async (_store, harnesses) => {
			harnesses.told?.('t1');
			await settle();
			await settle();
			turnOver = true;
			return Ok(undefined);
		});
		store.getJobThread.mockResolvedValue(
			Ok({
				id: 't1',
				orgId: 'org-1',
				agentId: 'login-1',
				personaId: 'persona-1',
				userId: 'user-1',
				parentThreadId: 'chat-1',
				title: null,
				taskId: null,
				harness: null,
				harnessSession: null,
				createdAt: now,
			}),
		);
		store.getChatThread.mockResolvedValue(
			Ok({
				id: 't1',
				orgId: 'org-1',
				agentId: 'login-1',
				personaId: 'persona-1',
				userId: 'user-1',
				parentThreadId: 'chat-1',
				title: null,
				taskId: null,
				harness: null,
				harnessSession: null,
				createdAt: now,
				state: {kind: 'working'},
				standing: {waitingForMember: false, summary: null, summarySeq: null},
				entries: [
					{id: 'e1', seq: 1, kind: 'person', text: 'Move the pricing review', pending: false, toolCalls: null, isError: false, createdAt: now},
					{
						id: 'e2',
						seq: 2,
						kind: 'assistant',
						text: 'Looking at the calendar first.',
						pending: false,
						toolCalls: [{id: 'c1', name: 'script', arguments: '{"code":"return 1"}'}],
						isError: false,
						createdAt: now,
					},
				],
				attachments: [],
			}),
		);
		store.writeThreadStanding.mockImplementation(async () => {
			writtenDuringTurn = !turnOver;
			return Ok(true);
		});
		const model: StandingModel = {key: 'sk-or-1', ask: mock<StandingModel['ask']>(async () => Ok({summary: 'Checking the calendar before moving the review.', waitingForMember: false}))};

		const worker = startHarnessWorker(store, harness, model);
		await settle();
		expect(writtenDuringTurn).toBe(true);
		expect(store.writeThreadStanding).toHaveBeenCalledWith('t1', {summary: 'Checking the calendar before moving the review.'}, 2, true);
		await worker.stop();
	});

	test('without a model to read it, where a thread stands is not read', async () => {
		const {startHarnessWorker} = await import('./worker');
		store.claimJob.mockResolvedValueOnce(Ok(claimed(inference))).mockResolvedValue(Ok(null));

		const worker = startHarnessWorker(store, harness);
		await settle();
		await worker.stop();

		expect(runInference).toHaveBeenCalledTimes(1);
		expect(store.getJobThread).not.toHaveBeenCalled();
	});
});
