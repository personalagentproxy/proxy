import {Err, type Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do} from '@proxy/utils';
import type {AlertRow, Landing, PollRow, WatchMatch} from '@proxy/db/alerts';
import type {ThreadRow} from '@proxy/db/harness';

import {log, serializeError} from '../observability/log';
import {noteRejectedSignIn} from '../connections/rejected-sign-in';
import {needsSignIn} from '../connections/unavailable';
import type {Change, Changes, RecordTarget} from '../records/connector';
import {integrationOf} from '../utils/connection-actions';
import {DEFAULT_TIME_ZONE, nextTime} from './alert-repeat';
import {dueText, matches, matchText, POLL_EVERY_MS} from './alerts';
import {alertOpening} from './thread-rules';
import {watchableConnections, watchedCollection} from './watch-connections';
import type {HarnessStore} from './store';

/**
 * The alerts' sweep, in each api instance: every minute it takes the timed alerts due and the polls
 * due, each moved on ten minutes as it is taken, so that one instance takes each. A timed alert
 * fires: what the agent noted lands as the alert is deleted, or, one that repeats, moved on to its
 * next time. A poll is looked at once for every watch on it: its connector says what is new since
 * where the last look left off (`changes`), and what carries any of a watch's words lands, after a
 * check that the agent may still read the connection for the member whose watch it is, all in the
 * transaction that moves the poll's cursor on. What lands goes into the thread the alert comes to,
 * or into new threads of its chat: one for the alert's time, and, for a watch, one for the look or
 * one for each record, as it splits, those past the ninth together in a tenth. Every turn is one transaction, so one
 * that fails, or is cut short as the instance stops, writes nothing; it is logged, and comes again
 * in ten minutes from where it was.
 */

// How often what is due is looked for, and how many of each kind one sweep takes at most.
const SWEEP_MS = 60 * 1000;
const SWEEP_LIMIT = 50;

// How many threads a watch that splits by record opens for one look at most: the records past one
// fewer go together in the last.
const MAX_THREADS_PER_LOOK = 10;

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

// The title of the thread the alert was set in, which one that opens new threads tells of; null
// for one that comes to its thread, and once the thread is gone.
function setInTitle(store: SweepStore, alert: AlertRow): Promise<Result<string | null, ApiError>> {
	return Do(async ($) => {
		if (alert.threadId !== null || alert.setInThreadId === null) {
			return null;
		}
		return $(await store.getJobThread(alert.setInThreadId))?.title ?? null;
	});
}

// Whether the watch's agent, acting in its chat as the member whose watch it is, may still read
// the connection: a read revoked since the watch was set delivers nothing.
function mayStillRead(store: SweepStore, chat: ThreadRow, poll: PollRow): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		const signedIn = $(await store.getThreadAgent(chat));
		if (!signedIn) {
			return false;
		}
		const watchable = $(await watchableConnections(signedIn, poll.collectionId));
		return watchable.some((connection) => connection.id === poll.connectionId);
	});
}

// The records a watch that splits by record opens a thread for each of, at most the most a look
// opens, those past one fewer together in the last.
function byRecord(changes: Change[]): Change[][] {
	if (changes.length <= MAX_THREADS_PER_LOOK) {
		return changes.map((change) => [change]);
	}
	const alone = changes.slice(0, MAX_THREADS_PER_LOOK - 1);
	return [...alone.map((change) => [change]), changes.slice(MAX_THREADS_PER_LOOK - 1)];
}

// What a watch's records that matched come to: one landing in its thread, or, opening new threads
// in its chat, one for them all, or one for each record, as it splits, each thread titled with the
// alert's title and the record's.
function watchLandings(watch: AlertRow, chat: ThreadRow, matched: Change[], setIn: string | null): Landing[] {
	if (watch.threadId !== null) {
		return [{text: matchText(watch, matched, setIn), opening: null}];
	}
	const groups = watch.split === 'per_record' ? byRecord(matched) : [matched];
	return groups.map((group) => {
		const only = group.length === 1 ? group[0] : undefined;
		const title = only === undefined ? watch.title : `${watch.title}: ${only.title}`;
		return {text: matchText(watch, group, setIn), opening: alertOpening(chat, {title, brief: watch.brief})};
	});
}

// What each watch is told of the changes: those that carry its words, where its agent may still
// read the connection; a check per chat, since the watches set in one share the member and the
// agent.
function watchMatches(store: SweepStore, watches: AlertRow[], changes: Change[], poll: PollRow): Promise<Result<WatchMatch[], ApiError>> {
	return Do(async ($) => {
		const allowed = new Map<string, ThreadRow | null>();
		const told: WatchMatch[] = [];
		for (const watch of watches) {
			const matched = changes.filter((change) => matches(watch.terms, change));
			if (matched.length === 0) {
				continue;
			}
			if (!allowed.has(watch.chatId)) {
				const chat = $(await store.getJobThread(watch.chatId));
				allowed.set(watch.chatId, chat !== null && $(await mayStillRead(store, chat, poll)) ? chat : null);
			}
			const chat = allowed.get(watch.chatId);
			if (chat) {
				told.push({alert: watch, landings: watchLandings(watch, chat, matched, $(await setInTitle(store, watch)))});
			}
		}
		return told;
	});
}

/**
 * Fires a timed alert: what it lands, in its thread or, opening new threads, a new one of its chat,
 * and its next time where it repeats, after now, so one missed while the sweep was down is skipped.
 */
export function fireDue(store: SweepStore, alert: AlertRow, now: Date): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		const text = dueText(alert, $(await setInTitle(store, alert)));
		const next = alert.every !== null && alert.at !== null ? nextTime({at: alert.at, every: alert.every, timeZone: alert.timeZone ?? DEFAULT_TIME_ZONE}, now) : null;
		if (alert.threadId !== null) {
			return $(await store.fireAlert(alert, {text, opening: null}, next));
		}
		const chat = $(await store.getJobThread(alert.chatId));
		if (!chat) {
			return false;
		}
		return $(await store.fireAlert(alert, {text, opening: alertOpening(chat, alert)}, next));
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
		const fired = await fireDue(store, alert, new Date());
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
