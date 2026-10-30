import {randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';

import {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {claimJob, failJob, type JobRow, renewLease} from '@proxy/db/harness';

import {log, serializeError} from '../observability/log';
import {runInference} from './inference';
import {runToolJob} from './tool-job';

/**
 * The worker that runs the built-in agents' jobs, a few at a time, in each api instance: it
 * claims the next job due while it has room, keeps each job's lease while it runs, and claims
 * the next as soon as one is done, so a turn's calls, the sub-agents started side by side and the
 * next turn follow each other without waiting; nothing due, it looks again in a moment. The queue
 * is the database, so instances need nothing of each other: one that goes down mid-job loses its
 * lease, and another picks the job up. Stopping, as for a deploy, the worker claims nothing more
 * and finishes the jobs it is on, up to a point.
 */

const POLL_MS = 500;
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
// How many jobs a worker runs at once.
const CONCURRENCY = 4;
// After this many claims, a job that keeps failing is given up.
const MAX_ATTEMPTS = 4;
// How long stopping waits for the jobs under way.
const STOP_MS = 8_000;

export type HarnessWorker = {stop: () => Promise<void>};

// One name per worker, so a lease says who holds it.
function workerName(): string {
	return `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

function run(job: JobRow, workerId: string): Promise<Result<void, ApiError>> {
	if (job.kind === 'inference') {
		return runInference(job, workerId);
	}
	return runToolJob(job, workerId);
}

// The failure in words, for the job's record and whoever is told of it.
function describe(failure: ApiError): string {
	if ('message' in failure && failure.message) {
		return failure.message;
	}
	if (failure.kind === 'not_found') {
		return `There is no ${failure.resource}${failure.id ? ` ${failure.id}` : ''}`;
	}
	if ('cause' in failure) {
		return failure.cause instanceof Error ? failure.cause.message : `${failure.kind}: ${JSON.stringify(failure.cause)}`;
	}
	return failure.kind;
}

// Runs the job with its lease kept, and marks it failed where it throws or fails.
async function runClaimed(job: JobRow, workerId: string): Promise<void> {
	if (job.attempts > MAX_ATTEMPTS) {
		await failJob(job.id, workerId, `Given up after ${job.attempts - 1} attempts`);
		return;
	}
	const renewal = setInterval(() => {
		void renewLease(job.id, workerId, LEASE_MS);
	}, RENEW_MS);
	const result = await Result.wrapAsync(() => run(job, workerId));
	clearInterval(renewal);
	const thrown = result.isErr() ? result.error : null;
	const failed = result.isOk() && result.value.isErr() ? result.value.error : null;
	if (thrown === null && failed === null) {
		return;
	}
	log.error('Built-in agent job failed', {jobId: job.id, kind: job.kind, attempt: job.attempts, ...serializeError(failed ?? thrown)});
	const message = failed ? describe(failed) : thrown instanceof Error ? thrown.message : String(thrown);
	await failJob(job.id, workerId, message.slice(0, 1000));
}

/** Starts the worker; it runs until stopped. */
export function startHarnessWorker(): HarnessWorker {
	const workerId = workerName();
	let stopping = false;
	const running = new Set<Promise<void>>();

	const loop = async (): Promise<void> => {
		while (!stopping) {
			if (running.size >= CONCURRENCY) {
				await Promise.race(running);
				continue;
			}
			const claimed = await claimJob(workerId, LEASE_MS);
			if (claimed.isErr()) {
				log.error('Built-in agent worker could not claim a job', serializeError(claimed.error));
				await sleep(POLL_MS * 4);
				continue;
			}
			if (claimed.value === null) {
				await sleep(POLL_MS);
				continue;
			}
			const job: Promise<void> = runClaimed(claimed.value, workerId).finally(() => running.delete(job));
			running.add(job);
		}
	};
	void loop();
	log.info('Built-in agent worker started', {workerId});

	return {
		stop: async () => {
			stopping = true;
			await Promise.race([Promise.all(running), sleep(STOP_MS)]);
		},
	};
}
