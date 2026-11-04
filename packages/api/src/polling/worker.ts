import {randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';

import {Result} from 'ts-results-es';

import {POLL_EVERY_MS} from '@proxy/utils/alerts';
import type {PollRow} from '@proxy/db/poll';

import {log, serializeError} from '../observability/log';
import {describeFailure} from '../utils/describe-failure';
import type {PollConsumer} from './consumer';
import {runPoll} from './run';
import type {PollStore} from './store';

/**
 * The worker that takes the looks due, a few at a time, in each api instance: it claims the next
 * poll due while it has room, keeps its lease while it looks, and claims the next as soon as one
 * is done; nothing due, it looks again in a moment. The polls are in the database, so instances
 * need nothing of each other: one that goes down mid-look loses its lease, and another takes the
 * poll up. A look that throws or fails is noted on the poll, with why, and comes again at the
 * next. Stopping, as for a deploy, the worker claims nothing more and finishes the looks it is
 * on, up to a point.
 */

const IDLE_MS = 2_000;
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
// How many looks a worker takes at once.
const CONCURRENCY = 2;
// How long stopping waits for the looks under way.
const STOP_MS = 8_000;

export type PollWorker = {stop: () => Promise<void>};

// One name per worker, so a lease says who holds it.
function workerName(): string {
	return `poll-${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

// Runs the poll with its lease kept; one that throws or fails is noted with why, and tried again
// at the next.
async function runClaimed(store: PollStore, consumers: PollConsumer[], poll: PollRow, workerId: string): Promise<void> {
	const renewal = setInterval(() => {
		void store.renewPollLease(poll.id, workerId, LEASE_MS);
	}, RENEW_MS);
	const result = await Result.wrapAsync(() => runPoll(store, consumers, poll, workerId));
	clearInterval(renewal);
	const thrown = result.isErr() ? result.error : null;
	const failed = result.isOk() && result.value.isErr() ? result.value.error : null;
	if (thrown === null && failed === null) {
		return;
	}
	log.error('A poll failed', {pollId: poll.id, connectionId: poll.connectionId, collectionId: poll.collectionId, ...serializeError(failed ?? thrown)});
	const message = failed ? describeFailure(failed) : thrown instanceof Error ? thrown.message : String(thrown);
	await store.finishPoll(poll.id, workerId, {cursor: poll.cursor, nextAt: new Date(Date.now() + POLL_EVERY_MS), error: message.slice(0, 1000)});
}

/** Starts the worker on the store, handing each look to the consumers; it runs until stopped. */
export function startPollWorker(store: PollStore, consumers: PollConsumer[]): PollWorker {
	const workerId = workerName();
	let stopping = false;
	const running = new Set<Promise<void>>();

	const loop = async (): Promise<void> => {
		while (!stopping) {
			if (running.size >= CONCURRENCY) {
				await Promise.race(running);
				continue;
			}
			const claimed = await store.claimPoll(workerId, LEASE_MS);
			if (claimed.isErr()) {
				log.error('The poll worker could not claim a poll', serializeError(claimed.error));
				await sleep(IDLE_MS * 4);
				continue;
			}
			if (claimed.value === null) {
				await sleep(IDLE_MS);
				continue;
			}
			const look: Promise<void> = runClaimed(store, consumers, claimed.value, workerId).finally(() => running.delete(look));
			running.add(look);
		}
	};
	void loop();
	log.info('Poll worker started', {workerId});

	return {
		stop: async () => {
			stopping = true;
			await Promise.race([Promise.all(running), sleep(STOP_MS)]);
		},
	};
}
