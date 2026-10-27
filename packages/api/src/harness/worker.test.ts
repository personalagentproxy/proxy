import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {JobRow} from '@proxy/db/harness';

type Run = (job: JobRow, workerId: string) => Promise<Result<void, ApiError>>;

const claimJob = mock();
const failJob = mock(async () => Ok(true));
const renewLease = mock(async () => Ok(true));
mock.module('@proxy/db/harness', () => ({claimJob, failJob, renewLease}));

const runInference = mock<Run>(async () => Ok(undefined));
mock.module('./inference', () => ({runInference}));

const runToolJob = mock<Run>(async () => Ok(undefined));
mock.module('./tool-job', () => ({runToolJob}));

const now = new Date();
const inference = {id: 'j1', threadId: 't1', kind: 'inference' as const, status: 'running' as const, entryId: null, callId: null, runAt: now, claimedBy: 'w', attempts: 1};
const tool = {...inference, id: 'j2', kind: 'tool' as const, entryId: 'e1', callId: 'c1'};

// Waits for the worker to get through what is queued.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
	mock.clearAllMocks();
});

describe('the worker', () => {
	test('claims jobs one after another and runs each by its kind, then stops claiming', async () => {
		const {startHarnessWorker} = await import('./worker');
		claimJob.mockResolvedValueOnce(Ok(inference)).mockResolvedValueOnce(Ok(tool)).mockResolvedValue(Ok(null));

		const worker = startHarnessWorker();
		await settle();
		await worker.stop();
		const claims = claimJob.mock.calls.length;
		await settle();

		expect(runInference).toHaveBeenCalledWith(inference, expect.any(String));
		expect(runToolJob).toHaveBeenCalledWith(tool, expect.any(String));
		expect(runInference.mock.calls[0]?.[1]).toBe(runToolJob.mock.calls[0]?.[1]);
		expect(claimJob.mock.calls.length).toBe(claims);
	});

	test('a job that fails, or throws, is marked failed with why, and one claimed too often is given up', async () => {
		const {startHarnessWorker} = await import('./worker');
		runInference.mockResolvedValueOnce(Err(ApiErr.conflict('no longer mine'))).mockResolvedValueOnce(Err(ApiErr.internalError(new Error('OpenRouter refused the request (400): too long'))));
		runToolJob.mockRejectedValueOnce(new Error('boom'));
		claimJob
			.mockResolvedValueOnce(Ok(inference))
			.mockResolvedValueOnce(Ok(tool))
			.mockResolvedValueOnce(Ok({...inference, id: 'j3', attempts: 5}))
			.mockResolvedValueOnce(Ok({...inference, id: 'j4'}))
			.mockResolvedValue(Ok(null));

		const worker = startHarnessWorker();
		await settle();
		await worker.stop();

		expect(failJob).toHaveBeenCalledWith('j1', expect.any(String), 'no longer mine');
		expect(failJob).toHaveBeenCalledWith('j2', expect.any(String), 'boom');
		expect(failJob).toHaveBeenCalledWith('j3', expect.any(String), 'Given up after 4 attempts');
		expect(failJob).toHaveBeenCalledWith('j4', expect.any(String), 'OpenRouter refused the request (400): too long');
		expect(runInference).toHaveBeenCalledTimes(2);
	});
});
