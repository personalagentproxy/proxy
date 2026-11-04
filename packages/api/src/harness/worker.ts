import {randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';

import {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {POLL_EVERY_MS} from '@proxy/utils/alerts';
import type {JobRow, PollRow} from '@proxy/db/harness';

import {log, serializeError} from '../observability/log';
import {type AlertJobStore, runAlertJob} from './alert-job';
import {failureNote} from './conversation';
import {describeFailure} from './failure';
import {type InferenceStore, runInference} from './inference';
import {type PollStore, runPoll} from './poll';
import type {HarnessStore} from './store';
import {runToolJob, type ToolJobStore} from './tool-job';

/**
 * The worker that runs the built-in agents' jobs, a few at a time, in each api instance: it
 * claims the next job due while it has room, keeps each job's lease while it runs, and claims
 * the next as soon as one is done, so a turn's calls, the sub-agents started side by side and the
 * next turn follow each other without waiting; no job due, it claims the next poll due, of the
 * connections watched (poll.ts), the same way; nothing due, it looks again in a moment. The queue
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

/** What the worker needs of the store: the queue, and what the jobs it runs need. */
export type WorkerStore = Pick<HarnessStore, 'claimJob' | 'renewLease' | 'failJob' | 'claimPoll' | 'renewPollLease'> & InferenceStore & ToolJobStore & AlertJobStore & PollStore;

// One name per worker, so a lease says who holds it.
function workerName(): string {
	return `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

function run(store: WorkerStore, job: JobRow, workerId: string): Promise<Result<void, ApiError>> {
	if (job.kind === 'inference') {
		return runInference(store, job, workerId);
	}
	if (job.kind === 'alert') {
		return runAlertJob(store, job, workerId);
	}
	return runToolJob(store, job, workerId);
}

// Marks the job failed, saying why, with what that leaves in its thread (conversation.ts).
async function fail(store: WorkerStore, job: JobRow, workerId: string, error: string): Promise<void> {
	await store.failJob(job.id, workerId, error, failureNote(error));
}

// Runs the job with its lease kept, and marks it failed where it throws or fails.
async function runClaimed(store: WorkerStore, job: JobRow, workerId: string): Promise<void> {
	if (job.attempts > MAX_ATTEMPTS) {
		await fail(store, job, workerId, `Given up after ${job.attempts - 1} attempts`);
		return;
	}
	const renewal = setInterval(() => {
		void store.renewLease(job.id, workerId, LEASE_MS);
	}, RENEW_MS);
	const result = await Result.wrapAsync(() => run(store, job, workerId));
	clearInterval(renewal);
	const thrown = result.isErr() ? result.error : null;
	const failed = result.isOk() && result.value.isErr() ? result.value.error : null;
	if (thrown === null && failed === null) {
		return;
	}
	log.error('Built-in agent job failed', {jobId: job.id, kind: job.kind, attempt: job.attempts, ...serializeError(failed ?? thrown)});
	const message = failed ? describeFailure(failed) : thrown instanceof Error ? thrown.message : String(thrown);
	await fail(store, job, workerId, message.slice(0, 1000));
}

// Runs the poll with its lease kept; one that throws or fails is noted with why, and tried again
// at the next.
async function runClaimedPoll(store: WorkerStore, poll: PollRow, workerId: string): Promise<void> {
	const renewal = setInterval(() => {
		void store.renewPollLease(poll.id, workerId, LEASE_MS);
	}, RENEW_MS);
	const result = await Result.wrapAsync(() => runPoll(store, poll, workerId));
	clearInterval(renewal);
	const thrown = result.isErr() ? result.error : null;
	const failed = result.isOk() && result.value.isErr() ? result.value.error : null;
	if (thrown === null && failed === null) {
		return;
	}
	log.error('A poll failed', {pollId: poll.id, connectionId: poll.connectionId, collectionId: poll.collectionId, ...serializeError(failed ?? thrown)});
	const message = failed ? describeFailure(failed) : thrown instanceof Error ? thrown.message : String(thrown);
	await store.finishPoll(poll.id, workerId, {cursor: poll.cursor, nextAt: new Date(Date.now() + POLL_EVERY_MS), error: message.slice(0, 1000), matches: []});
}

/** Starts the worker on the store; it runs until stopped. */
export function startHarnessWorker(store: WorkerStore): HarnessWorker {
	const workerId = workerName();
	let stopping = false;
	const running = new Set<Promise<void>>();

	const loop = async (): Promise<void> => {
		while (!stopping) {
			if (running.size >= CONCURRENCY) {
				await Promise.race(running);
				continue;
			}
			const claimed = await store.claimJob(workerId, LEASE_MS);
			if (claimed.isErr()) {
				log.error('Built-in agent worker could not claim a job', serializeError(claimed.error));
				await sleep(POLL_MS * 4);
				continue;
			}
			if (claimed.value !== null) {
				const job: Promise<void> = runClaimed(store, claimed.value, workerId).finally(() => running.delete(job));
				running.add(job);
				continue;
			}
			const poll = await store.claimPoll(workerId, LEASE_MS);
			if (poll.isErr()) {
				log.error('Built-in agent worker could not claim a poll', serializeError(poll.error));
				await sleep(POLL_MS * 4);
				continue;
			}
			if (poll.value === null) {
				await sleep(POLL_MS);
				continue;
			}
			const look: Promise<void> = runClaimedPoll(store, poll.value, workerId).finally(() => running.delete(look));
			running.add(look);
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
