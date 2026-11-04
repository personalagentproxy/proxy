import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import type {AlertRow, PollRow} from '@proxy/db/alerts';
import {findCollection} from '@proxy/integrations';

import {log, serializeError} from '../observability/log';
import {type Change, type Changes, isRecordStore, type RecordTarget} from '../records/connector';
import {connectorFor} from '../records/connectors';
import {integrationOf} from '../utils/connection-actions';
import {matches, matchText, POLL_EVERY_MS, watchableConnections} from './alerts';
import type {HarnessStore} from './store';

/**
 * The watches' poller, in each api instance: every so often it takes the polls due, each moved on
 * ten minutes as it is taken, so that one instance looks at each connection's collection. A look
 * asks the connection's connector for what is new since the last look (`changes`), matches it
 * against each watch on the collection, and lands the matches in the watches' conversations, after
 * a check that the agent may still read the connection for the member whose watch it is; then the
 * poll notes where the look left off. A look that fails is logged, and comes again in ten minutes
 * from where it was. A poll no watch is on, or whose connection is gone or doesn't poll the
 * collection, is deleted.
 */

// How often the polls due are looked for.
const SWEEP_MS = 60 * 1000;

export type WatchPoller = {stop: () => void};

/** What the poller needs of the store. */
export type WatchStore = Pick<HarnessStore, 'claimDuePolls' | 'setPollCursor' | 'deletePoll' | 'listWatches' | 'getPollConnection' | 'getJobThread' | 'getThreadAgent' | 'appendEvent'>;

// The connection's collection and its connector's `changes`, where the connection is there and
// its integration polls the collection.
function pollTarget(store: WatchStore, poll: PollRow): Promise<Result<(RecordTarget & {changes: Changes}) | null, ApiError>> {
	return Do(async ($) => {
		const connection = $(await store.getPollConnection(poll.connectionId));
		if (!connection) {
			return null;
		}
		const integration = integrationOf(connection);
		const collection = integration ? findCollection(integration, poll.collectionId) : undefined;
		const connector = connectorFor(connection.integrationId, poll.collectionId);
		if (!collection || !connector || !isRecordStore(connector) || !connector.changes) {
			return null;
		}
		return {connection, collection, changes: connector.changes};
	});
}

// Whether the watch's agent, acting as the member whose watch it is, may still read the connection:
// a read revoked since the watch was set delivers nothing.
async function stillAllowed(store: WatchStore, watch: AlertRow, poll: PollRow): Promise<boolean> {
	const thread = await store.getJobThread(watch.threadId);
	if (thread.isErr() || !thread.value) {
		return false;
	}
	const signedIn = await store.getThreadAgent(thread.value);
	if (signedIn.isErr() || !signedIn.value) {
		return false;
	}
	const watchable = await watchableConnections(signedIn.value, poll.collectionId);
	return watchable.isOk() && watchable.value.some((connection) => connection.id === poll.connectionId);
}

// Lands each watch's matches among the changes in its conversation; a check per conversation,
// since the watches set in one share the member and the agent.
function tellWatches(store: WatchStore, watches: AlertRow[], changes: Change[], poll: PollRow): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const allowed = new Map<string, boolean>();
		for (const watch of watches) {
			const matched = changes.filter((change) => matches(watch.terms, change));
			if (matched.length === 0) {
				continue;
			}
			const may = allowed.get(watch.threadId) ?? (await stillAllowed(store, watch, poll));
			allowed.set(watch.threadId, may);
			if (!may) {
				continue;
			}
			$(await store.appendEvent(watch.threadId, matchText(watch, matched)));
		}
	});
}

/** One look at a connection's collection, for the watches on it; nothing when none is left. */
export function runPoll(store: WatchStore, poll: PollRow, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const watches = $(await store.listWatches(poll.connectionId, poll.collectionId));
		const target = watches.length === 0 ? null : $(await pollTarget(store, poll));
		if (!target) {
			$(await store.deletePoll(poll));
			return;
		}
		const changed = $(await target.changes(target, poll.cursor, now));
		$(await tellWatches(store, watches, changed.items, poll));
		$(await store.setPollCursor(poll, changed.cursor));
	});
}

/** The polls due, each looked at in turn; one that fails is logged and comes again. */
export async function sweep(store: WatchStore, now = new Date()): Promise<void> {
	const due = await store.claimDuePolls(POLL_EVERY_MS);
	if (due.isErr()) {
		log.error('The watches’ poller could not take the polls due', serializeError(due.error));
		return;
	}
	for (const poll of due.value) {
		const result = await runPoll(store, poll, now);
		if (result.isErr()) {
			log.warn('A look for the watches failed', {connectionId: poll.connectionId, collectionId: poll.collectionId, ...serializeError('cause' in result.error ? result.error.cause : result.error)});
		}
	}
}

/** Starts the poller on the store; it sweeps until stopped. */
export function startWatchPoller(store: WatchStore): WatchPoller {
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) {
			return;
		}
		running = true;
		await sweep(store).catch((error: unknown) => log.error('The watches’ poller failed', serializeError(error)));
		running = false;
	};
	const timer = setInterval(() => void tick(), SWEEP_MS);
	void tick();
	log.info('Watch poller started');
	return {
		stop: () => {
			clearInterval(timer);
		},
	};
}
