import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {matches, parseCriteria, type PollItem} from '@proxy/utils/alerts';
import type {AlertRow, MatchedItem} from '@proxy/db/harness';
import type {PollRow} from '@proxy/db/poll';

import type {PollConsumer} from '../polling/consumer';
import {connectionGoneText, itemSummary} from './alerts';
import type {HarnessStore} from './store';
import {watchableConnections} from './watch-connections';

/**
 * The watches as what polling looks for (polling/consumer.ts): a connection's collection is
 * wanted looked at while any watch is on it; what a look finds is matched against each watch's
 * criteria, mechanically, and the matches land in the watches' conversations (db/harness
 * landMatches), each record once, after a check that the agent may still read the connection for
 * the member whose watch it is. A connection gone ends the watches left watching nothing. A look
 * handed twice lands nothing twice.
 */

/** What the watches need of the store. */
export type WatchStore = Pick<HarnessStore, 'listWatches' | 'landMatches' | 'dropConnectionFromWatches' | 'getJobThread' | 'getThreadAgent'>;

// Whether the watch's agent, acting as the member whose watch it is, may still read the
// connection: a read revoked since the watch was set delivers nothing.
async function stillAllowed(store: WatchStore, alert: AlertRow, poll: PollRow): Promise<boolean> {
	const thread = await store.getJobThread(alert.threadId);
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

// Each watch's matches among the records found, for the watches that may still be told; a check
// per conversation, since the watches set in one share the member and the agent.
async function matchesFor(store: WatchStore, watches: AlertRow[], items: MatchedItem[], poll: PollRow): Promise<Array<{alert: AlertRow; items: MatchedItem[]}>> {
	const allowed = new Map<string, boolean>();
	const found: Array<{alert: AlertRow; items: MatchedItem[]}> = [];
	for (const alert of watches) {
		const criteria = parseCriteria(alert.criteria);
		const matched = items.filter((item) => matches(criteria, item));
		if (matched.length === 0) {
			continue;
		}
		const may = allowed.get(alert.threadId) ?? (await stillAllowed(store, alert, poll));
		allowed.set(alert.threadId, may);
		if (may) {
			found.push({alert, items: matched});
		}
	}
	return found;
}

function handle(store: WatchStore, poll: PollRow, items: PollItem[]): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (items.length === 0) {
			return;
		}
		const watches = $(await store.listWatches(poll.connectionId, poll.collectionId));
		const found = await matchesFor(
			store,
			watches,
			items.map((item) => ({...item, summary: itemSummary(item)})),
			poll,
		);
		if (found.length === 0) {
			return;
		}
		$(await store.landMatches(poll, found));
	});
}

/** The watches, on the store, as a consumer of what polling finds. */
export function watchConsumer(store: WatchStore): PollConsumer {
	return {
		wants: (poll) => Do(async ($) => $(await store.listWatches(poll.connectionId, poll.collectionId)).length > 0),
		handle: (poll, items) => handle(store, poll, items),
		connectionGone: (poll) => store.dropConnectionFromWatches(poll.connectionId, poll.collectionId, connectionGoneText),
	};
}
