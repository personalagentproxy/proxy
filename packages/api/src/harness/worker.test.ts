import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {JobRow} from '@proxy/db/harness';

import {type FakeStore, fakeStore} from './fake-store';

type Run = (store: FakeStore, job: JobRow, workerId: string) => Promise<Result<void, ApiError>>;

const runInference = mock<Run>(async () => Ok(undefined));
mock.module('./inference', () => ({runInference}));

const runToolJob = mock<Run>(async () => Ok(undefined));
mock.module('./tool-job', () => ({runToolJob}));

const now = new Date();
const inference: JobRow = {id: 'j1', threadId: 't1', kind: 'inference', status: 'running', entryId: null, callId: null, runAt: now, claimedBy: 'w', attempts: 1};
const tool: JobRow = {...inference, id: 'j2', kind: 'tool', entryId: 'e1', callId: 'c1'};

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
	test('claims jobs one after another and runs each by its kind, on the store, then stops claiming', async () => {
		const {startHarnessWorker} = await import('./worker');
		store.claimJob.mockResolvedValueOnce(Ok(inference)).mockResolvedValueOnce(Ok(tool)).mockResolvedValue(Ok(null));

		const worker = startHarnessWorker(store);
		await settle();
		await worker.stop();
		const claims = store.claimJob.mock.calls.length;
		await settle();

		expect(runInference).toHaveBeenCalledWith(store, inference, expect.any(String));
		expect(runToolJob).toHaveBeenCalledWith(store, tool, expect.any(String));
		expect(runInference.mock.calls[0]?.[2]).toBe(runToolJob.mock.calls[0]?.[2]);
		expect(store.claimJob.mock.calls.length).toBe(claims);
	});

	test('a job that fails, or throws, is marked failed with why, and one claimed too often is given up', async () => {
		const {startHarnessWorker} = await import('./worker');
		runInference.mockResolvedValueOnce(Err(ApiErr.conflict('no longer mine'))).mockResolvedValueOnce(Err(ApiErr.internalError(new Error('OpenRouter refused the request (400): too long'))));
		runToolJob.mockRejectedValueOnce(new Error('boom'));
		store.claimJob
			.mockResolvedValueOnce(Ok(inference))
			.mockResolvedValueOnce(Ok(tool))
			.mockResolvedValueOnce(Ok({...inference, id: 'j3', attempts: 5}))
			.mockResolvedValueOnce(Ok({...inference, id: 'j4'}))
			.mockResolvedValue(Ok(null));

		const worker = startHarnessWorker(store);
		await settle();
		await worker.stop();

		// With what the failure leaves in the thread (conversation.test.ts).
		expect(store.failJob).toHaveBeenCalledWith('j1', expect.any(String), 'no longer mine', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j2', expect.any(String), 'boom', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j3', expect.any(String), 'Given up after 4 attempts', expect.any(Function));
		expect(store.failJob).toHaveBeenCalledWith('j4', expect.any(String), 'OpenRouter refused the request (400): too long', expect.any(Function));
		expect(runInference).toHaveBeenCalledTimes(2);

		const thread = {id: 't1', orgId: 'o1', agentId: 'a1', personaId: 'p1', userId: 'u1', parentThreadId: null, parentCallId: null, title: null, taskId: null, finishedAt: null, createdAt: now};
		const noteFor = store.failJob.mock.calls.find((call) => call[0] === 'j2')?.[3];
		expect(noteFor?.(tool, thread)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: boom'});
	});
});
