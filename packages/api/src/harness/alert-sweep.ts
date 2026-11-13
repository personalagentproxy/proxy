import {Err, type Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do} from '@proxy/utils';
import type {AlertRow, PollRow, WatchMatch} from '@proxy/db/alerts';

import {log, serializeError} from '../observability/log';
import {noteRejectedSignIn} from '../connections/rejected-sign-in';
import {needsSignIn} from '../connections/unavailable';
import type {Change, Changes, RecordTarget} from '../records/connector';
import {integrationOf} from '../utils/connection-actions';
import {dueText, matches, matchText, POLL_EVERY_MS} from './alerts';
import {watchableConnections, watchedCollection} from './watch-connections';
import type {HarnessStore} from './store';

/**
 * The alerts' sweep, in each api instance: every minute it takes the timed alerts due and the polls
 * due, each moved on ten minutes as it is taken, so that one instance takes each. A timed alert
 * fires: what the agent noted lands in its thread as the alert is deleted. A poll is looked
 * at once for every watch on it: its connector says what is new since where the last look left
 * off (`changes`), and what carries any of a watch's words lands in the watch's thread,
 * after a check that the agent may still read the connection for the member whose watch it is,
 * all in the transaction that moves the poll's cursor on. Every turn is one transaction, so one
 * that fails, or is cut short as the instance stops, writes nothing; it is logged, and comes again
 * in ten minutes from where it was.
 */

// How often what is due is looked for, and how many of each kind one sweep takes at most.
const SWEEP_MS = 60 * 1000;
const SWEEP_LIMIT = 50;

export type AlertSweeper = {stop: () => void};

/** What the sweep needs of the store. */
export type SweepStore = Pick<HarnessStore, 'claimDueAlerts' | 'fireAlert' | 'claimDuePolls' | 'listWatches' | 'recordLook' | 'getPollConnection' | 'getJobThread' | 'getThreadAgent'>;

// The poll's connection and collection, with its connector's `changes`.
function pollTarget(store: SweepStore, poll: PollRow): Promise<Result<RecordTarget & {changes: Changes}, ApiError>> {
	return Do(async ($) => {
		const connection = $(await store.getPollConnection(poll.connectionId));
		if (!connection) {
			return $(Err(ApiErr.notFound('connection', poll.connectionId)));
		}
		const watched = watchedCollection(integrationOf(connection), connection.integrationId, poll.collectionId);
		if (!watched) {
			return $(Err(ApiErr.notFound('collection', poll.collectionId)));
		}
		return {connection, ...watched};
	});
}

// Whether the watch's agent, acting as the member whose watch it is, may still read the connection:
// a read revoked since the watch was set delivers nothing.
function mayStillRead(store: SweepStore, watch: AlertRow, poll: PollRow): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		const thread = $(await store.getJobThread(watch.threadId));
		if (!thread) {
			return false;
		}
		const signedIn = $(await store.getThreadAgent(thread));
		if (!signedIn) {
			return false;
		}
		const watchable = $(await watchableConnections(signedIn, poll.collectionId));
		return watchable.some((connection) => connection.id === poll.connectionId);
	});
}

// What each watch is told of the changes: those that carry its words, where its agent may still
// read the connection; a check per thread, since the watches set in one share the member and the
// agent.
function watchMatches(store: SweepStore, watches: AlertRow[], changes: Change[], poll: PollRow): Promise<Result<WatchMatch[], ApiError>> {
	return Do(async ($) => {
		const allowed = new Map<string, boolean>();
		const told: WatchMatch[] = [];
		for (const watch of watches) {
			const matched = changes.filter((change) => matches(watch.terms, change));
			if (matched.length === 0) {
				continue;
			}
			const may = allowed.get(watch.threadId) ?? $(await mayStillRead(store, watch, poll));
			allowed.set(watch.threadId, may);
			if (may) {
				told.push({alert: watch, text: matchText(watch, matched)});
			}
		}
		return told;
	});
}

/** One look at a connection's collection, for every watch on it. */
export function runPoll(store: SweepStore, poll: PollRow, now: Date): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const watches = $(await store.listWatches(poll.connectionId, poll.collectionId));
		if (watches.length === 0) {
			return;
		}
		const target = $(await pollTarget(store, poll));
		// Nothing is asked of a provider that turned the sign-in down until it is signed in to again.
		if (needsSignIn(target.connection)) {
			return;
		}
		const changed = $(await noteRejectedSignIn(target.connection, target.connection.credential, await target.changes(target, poll.cursor, now)));
		const told = $(await watchMatches(store, watches, changed.items, poll));
		$(await store.recordLook(poll, changed.cursor, told, now));
	});
}

/** The timed alerts due, then the polls due, each taken in turn; one that fails is logged and comes again. */
export async function sweep(store: SweepStore): Promise<void> {
	const alerts = await store.claimDueAlerts(POLL_EVERY_MS, SWEEP_LIMIT);
	if (alerts.isErr()) {
		log.error('The alerts’ sweep could not take the alerts due', serializeError(alerts.error));
	}
	for (const alert of alerts.unwrapOr([])) {
		const fired = await store.fireAlert(alert, dueText(alert));
		if (fired.isErr()) {
			log.warn('An alert could not fire', {alertId: alert.id, ...serializeError(fired.error)});
		}
	}
	const polls = await store.claimDuePolls(POLL_EVERY_MS, SWEEP_LIMIT);
	if (polls.isErr()) {
		log.error('The alerts’ sweep could not take the polls due', serializeError(polls.error));
	}
	for (const poll of polls.unwrapOr([])) {
		const result = await runPoll(store, poll, new Date());
		if (result.isErr()) {
			log.warn('A look for the watches failed', {connectionId: poll.connectionId, collectionId: poll.collectionId, ...serializeError('cause' in result.error ? result.error.cause : result.error)});
		}
	}
}

/** Starts the sweep on the store; it runs until stopped. */
export function startAlertSweeper(store: SweepStore): AlertSweeper {
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) {
			return;
		}
		running = true;
		await sweep(store).catch((error: unknown) => log.error('The alerts’ sweep failed', serializeError(error)));
		running = false;
	};
	const timer = setInterval(() => void tick(), SWEEP_MS);
	void tick();
	log.info('Alert sweeper started');
	return {
		stop: () => {
			clearInterval(timer);
		},
	};
}
