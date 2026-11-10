import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {fakeHarness} from '@proxy/backends/harness/fake';
import {ApiErr, type ApiError} from '@proxy/utils';
import type {ClaimedJob, JobRow} from '@proxy/db/harness';

import type {Harnesses} from '../backends/harness';
import {type FakeStore, fakeStore} from './fake-store';

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

		expect(runInference).toHaveBeenCalledWith(store, harness, inference, expect.any(String), false);
		expect(runToolJob).toHaveBeenCalledWith(store, tool, expect.any(String));
		// A wake-up after a sleep is a turn too, the harness told it is one.
		expect(runInference).toHaveBeenCalledWith(store, harness, wake, expect.any(String), true);
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
		expect(runInference).toHaveBeenCalledWith(store, capped, inference, expect.any(String), false);
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

		// With what the failure leaves in the thread (conversation.test.ts).
		expect(store.failJob).toHaveBeenCalledWith('j1', expect.any(String), 'no longer mine', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j2', expect.any(String), 'boom', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j3', expect.any(String), 'Given up after 4 attempts', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j4', expect.any(String), 'OpenRouter refused the request (400): too long', expect.any(Function));
		expect(runInference).toHaveBeenCalledTimes(2);

		const thread = {
			id: 't1',
			orgId: 'o1',
			agentId: 'a1',
			personaId: 'p1',
			userId: 'u1',
			parentThreadId: null,
			parentCallId: null,
			title: null,
			taskId: null,
			harness: null,
			harnessSession: null,
			createdAt: now,
		};
		const noteFor = store.failJob.mock.calls.find((call) => call[0] === 'j2')?.[3];
		expect(noteFor?.(tool, thread)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: boom'});
	});
});
