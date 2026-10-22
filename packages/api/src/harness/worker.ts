import {randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';

import {Result} from 'ts-results-es';

import {claimJob, failJob, type JobRow, renewLease} from '@proxy/db/harness';

import {log, serializeError} from '../observability/log';
import {runInference} from './inference';
import {runToolJob} from './tool-job';

/**
 * The worker that runs the built-in agent's jobs, one at a time, in each api instance: it claims
 * the next job due, keeps its lease while the job runs, and claims the next as soon as it is done,
 * so a turn's calls and the next turn follow each other without waiting; nothing due, it looks
 * again in a moment. The queue is the database, so instances need nothing of each other: one that
 * goes down mid-job loses its lease, and another picks the job up. Stopping, as for a deploy, the
 * worker claims nothing more and finishes the job it is on, up to a point.
 */

const POLL_MS = 500;
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
// After this many claims, a job that keeps failing is given up.
const MAX_ATTEMPTS = 4;
// How long stopping waits for the job under way.
const STOP_MS = 8_000;

export type HarnessWorker = {stop: () => Promise<void>};

// One name per worker, so a lease says who holds it.
function workerName(): string {
	return `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

function run(job: JobRow, workerId: string): Promise<Result<void, unknown>> {
	if (job.kind === 'inference') {
		return runInference(job, workerId);
	}
	return runToolJob(job, workerId);
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
	const failure = result.isErr() ? result.error : result.value.isErr() ? result.value.error : null;
	if (failure === null) {
		return;
	}
	log.error('Built-in agent job failed', {jobId: job.id, kind: job.kind, attempt: job.attempts, ...serializeError(failure)});
	const message = failure instanceof Error ? failure.message : JSON.stringify(failure);
	await failJob(job.id, workerId, message.slice(0, 1000));
}

/** Starts the worker; it runs until stopped. */
export function startHarnessWorker(): HarnessWorker {
	const workerId = workerName();
	let stopping = false;
	let current: Promise<void> = Promise.resolve();

	const loop = async (): Promise<void> => {
		while (!stopping) {
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
			current = runClaimed(claimed.value, workerId);
			await current;
		}
	};
	void loop();
	log.info('Built-in agent worker started', {workerId});

	return {
		stop: async () => {
			stopping = true;
			await Promise.race([current, sleep(STOP_MS)]);
		},
	};
}
