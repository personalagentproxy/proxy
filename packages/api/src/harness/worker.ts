import {randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';

import {Err, Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {JobRow} from '@proxy/db/harness';

import {cappedHarness, type Harnesses} from '../backends/harness';
import {log, serializeError} from '../observability/log';
import {agentMetrics} from '../observability/metrics';
import {runInContext} from '../observability/request-context';
import {failureNote} from './thread-rules';
import {type InferenceStore, runInference} from './inference';
import type {HarnessStore} from './store';
import {standAfterTurn, type StandingModel, type StandingStore} from './thread-standing';
import {titleAtStart, type TitleModel, type TitleStore} from './thread-title';
import {runToolJob, type ToolJobStore} from './tool-job';

/**
 * The worker that runs the built-in agents' jobs, a few at a time, in each api instance: it
 * claims the next job due while it has room, keeps each job's lease while it runs, and claims
 * the next as soon as one is done, so a turn's calls, threads at work side by side and the next
 * turn follow one another without waiting; nothing due, it looks again in a moment. The queue
 * is the database, so instances need nothing of each other: one that goes down mid-job loses its
 * lease, and another picks the job up. Stopping, as for a deploy, the worker claims nothing more
 * and finishes the jobs it is on, up to a point. An inference job is a turn of a harness
 * (@proxy/backends/harness), chosen for its thread among those the worker was given
 * (backends/harness.ts), and a wake job one too, after a sleep the harness answered itself, told
 * so; a thread none fits, as on a server without an OpenRouter key, has the person told so
 * (inference.ts). The turns of personas on the SDK harness, each a subprocess, are capped
 * (backends/harness.ts): the worker counts those it runs, and, at the cap, claims only the other
 * jobs, so a turn it has no subprocess for stays in the queue, for it later or for another
 * instance, rather than taking up room here while it waits. As a thread's turn ends, a small model
 * reads where it stands, after the turn's job and beside the next (thread-standing.ts); stopping,
 * the worker waits for those readings as it does for its jobs.
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

/** What the worker needs of the store: the queue, what the jobs it runs need, and where a thread stands. */
export type WorkerStore = Pick<HarnessStore, 'claimJob' | 'renewLease' | 'failJob'> & InferenceStore & ToolJobStore & StandingStore & TitleStore;

// Without the server's OpenRouter key, no thread's standing is read: each is done, with no summary.
const NO_STANDING: StandingModel = {key: undefined, ask: async () => Err(ApiErr.unavailable('No model reads where a thread stands'))};

// Without it, no thread is named: each keeps the line of the message it was opened with.
const NO_TITLE: TitleModel = {key: undefined, ask: async () => Err(ApiErr.unavailable('No model names a thread'))};

// One name per worker, so a lease says who holds it.
function workerName(): string {
	return `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

// A job by its kind: a turn, or a wake-up after a sleep, which is a turn the harness is told was
// one; or a tool call.
function run(store: WorkerStore, harnesses: Harnesses, job: JobRow, workerId: string): Promise<Result<void, ApiError>> {
	if (job.kind === 'inference' || job.kind === 'wake') {
		return runInference(store, harnesses, job, workerId, job.kind === 'wake');
	}
	return runToolJob(store, job, workerId);
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

// Marks the job failed, saying why, with what that leaves in its thread (thread-rules.ts).
async function fail(store: WorkerStore, job: JobRow, workerId: string, error: string): Promise<void> {
	await store.failJob(job.id, workerId, error, failureNote(error));
}

// Runs the job with its lease kept, and marks it failed where it throws or fails.
async function runOrFail(store: WorkerStore, harnesses: Harnesses, job: JobRow, workerId: string): Promise<void> {
	if (job.attempts > MAX_ATTEMPTS) {
		await fail(store, job, workerId, `Given up after ${job.attempts - 1} attempts`);
		return;
	}
	const renewal = setInterval(() => {
		void store.renewLease(job.id, workerId, LEASE_MS);
	}, RENEW_MS);
	const startedAt = performance.now();
	const result = await Result.wrapAsync(() => run(store, harnesses, job, workerId));
	clearInterval(renewal);
	const thrown = result.isErr() ? result.error : null;
	const failed = result.isOk() && result.value.isErr() ? result.value.error : null;
	agentMetrics.recordJob({
		kind: job.kind,
		status: thrown !== null ? 'thrown' : failed !== null ? 'failed' : 'done',
		durationMs: Math.round(performance.now() - startedAt),
	});
	if (thrown === null && failed === null) {
		return;
	}
	log.error('Built-in agent job failed', {jobId: job.id, kind: job.kind, attempt: job.attempts, ...serializeError(failed ?? thrown)});
	const message = failed ? describe(failed) : thrown instanceof Error ? thrown.message : String(thrown);
	await fail(store, job, workerId, message.slice(0, 1000));
}

/** Starts the worker on the store, its inference jobs run by the harness `harnesses` has for each thread, where a thread stands as its turn ends read by `standing`, and a thread named as its first turn starts by `title`; it runs until stopped. */
export function startHarnessWorker(store: WorkerStore, harnesses: Harnesses, standing: StandingModel = NO_STANDING, title: TitleModel = NO_TITLE): HarnessWorker {
	const workerId = workerName();
	const cap = cappedHarness(harnesses.registry);
	let stopping = false;
	const running = new Set<Promise<void>>();
	// Where threads stand, being written after their turns' jobs, and their titles, written beside
	// their first: none takes a job's room.
	const standings = new Set<Promise<void>>();
	// How many of the jobs running are turns on the capped harness.
	let cappedTurns = 0;

	// Runs the job, and, a turn's job over, however it went, has where its thread stands written
	// after, in the background, so the worker goes on to the next job meanwhile: the thread's turn
	// may have ended, and where it hasn't, nothing is written (thread-standing.ts).
	const runClaimed = async (job: JobRow): Promise<void> => {
		// A turn's job names its thread beside it, where nothing has yet (thread-title.ts), so the
		// title comes while the turn is still at work.
		if (job.kind === 'inference') {
			const named: Promise<void> = titleAtStart(store, title, job.threadId).finally(() => {
				standings.delete(named);
			});
			standings.add(named);
		}
		await runOrFail(store, harnesses, job, workerId);
		if (job.kind !== 'inference' && job.kind !== 'wake') {
			return;
		}
		const written: Promise<void> = standAfterTurn(store, standing, job.threadId).finally(() => {
			standings.delete(written);
		});
		standings.add(written);
	};

	const loop = async (): Promise<void> => {
		while (!stopping) {
			if (running.size >= CONCURRENCY) {
				await Promise.race(running);
				continue;
			}
			const claimed = await store.claimJob(workerId, LEASE_MS, cap && {harness: cap.harness, full: cappedTurns >= cap.turns});
			if (claimed.isErr()) {
				log.error('Built-in agent worker could not claim a job', serializeError(claimed.error));
				await sleep(POLL_MS * 4);
				continue;
			}
			if (claimed.value === null) {
				await sleep(POLL_MS);
				continue;
			}
			const {capped, ...row} = claimed.value;
			cappedTurns += capped ? 1 : 0;
			// Every line written for the job says which it was, as a request's say which request.
			const job: Promise<void> = runInContext({jobId: row.id, jobKind: row.kind, threadId: row.threadId, workerId}, () => runClaimed(row)).finally(() => {
				running.delete(job);
				cappedTurns -= capped ? 1 : 0;
			});
			running.add(job);
		}
	};
	void loop();
	log.info('Built-in agent worker started', {workerId});

	return {
		stop: async () => {
			stopping = true;
			// A job done has begun writing where its thread stands by then, so those are waited for
			// after the jobs.
			const settled = async (): Promise<void> => {
				await Promise.all(running);
				await Promise.all(standings);
			};
			await Promise.race([settled(), sleep(STOP_MS)]);
		},
	};
}
