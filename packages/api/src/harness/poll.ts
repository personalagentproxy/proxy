import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {matches, parseCriteria, POLL_EVERY_MS} from '@proxy/utils/alerts';
import type {AlertRow, MatchedItem, PollRow} from '@proxy/db/harness';
import {findCollection} from '@proxy/integrations';

import {isRecordStore, type Changes, type RecordTarget} from '../records/connector';
import {connectorFor} from '../records/connectors';
import {integrationOf} from '../utils/connection-actions';
import {log, serializeError} from '../observability/log';
import {connectionGoneText, itemSummary} from './alerts';
import {describeFailure} from './failure';
import type {HarnessStore} from './store';
import {watchableConnections} from './watch-connections';

/**
 * A poll: one collection of one connection, looked at for what is new or changed since the last
 * look, as the connector tells it (`changes`), while any watch is on it. What is new is matched
 * against each watch's criteria, mechanically, and the matches land in the watches' conversations
 * (db/harness finishPoll), each once, after a check that the agent may still read the connection
 * for the member whose watch it is. The look is logged as Personal Agent Proxy's own, as a
 * widget's is. A poll with no watch left on it deletes itself; one whose connection is gone ends
 * the watches left watching nothing, and deletes itself. A look that fails is noted on the poll,
 * for the Alerts page, and tried again at the next; the cursor stays where it was.
 */

/** What a poll needs of the store. */
export type PollStore = Pick<HarnessStore, 'listPollRules' | 'deletePoll' | 'finishPoll' | 'dropConnectionFromWatches' | 'getPollConnection' | 'logPoll' | 'getJobThread' | 'getThreadAgent'>;

// The connection's collection and its connector's `changes`, where the connection is there and
// its integration polls the collection.
async function pollTarget(store: PollStore, poll: PollRow): Promise<Result<(RecordTarget & {changes: Changes}) | null, ApiError>> {
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

// Whether the watch's agent, acting as the member whose watch it is, may still read the
// connection: a read revoked since the watch was set delivers nothing.
async function stillAllowed(store: PollStore, alert: AlertRow, poll: PollRow): Promise<boolean> {
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

// Each watch's matches among the new records, for the watches that may still be told; a check
// per conversation, since the watches set in one share the member and the agent.
async function matchesFor(store: PollStore, rules: AlertRow[], items: MatchedItem[], poll: PollRow): Promise<Array<{alert: AlertRow; items: MatchedItem[]}>> {
	const allowed = new Map<string, boolean>();
	const found: Array<{alert: AlertRow; items: MatchedItem[]}> = [];
	for (const alert of rules) {
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

/** Runs the poll: the connection's collection looked at, the matches told, and the next look due; nothing when no watch is left on it. */
export function runPoll(store: PollStore, poll: PollRow, workerId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const rules = $(await store.listPollRules(poll.connectionId, poll.collectionId));
		if (rules.length === 0) {
			$(await store.deletePoll(poll.id));
			return;
		}
		const target = $(await pollTarget(store, poll));
		if (!target) {
			$(await store.dropConnectionFromWatches(poll.connectionId, poll.collectionId, connectionGoneText));
			$(await store.deletePoll(poll.id));
			return;
		}
		const nextAt = new Date(now.getTime() + POLL_EVERY_MS);
		const changed = await target.changes(target, poll.cursor, now);
		if (changed.isErr()) {
			log.warn('A poll could not look at its connection', {
				pollId: poll.id,
				connectionId: poll.connectionId,
				collectionId: poll.collectionId,
				...serializeError('cause' in changed.error ? changed.error.cause : changed.error),
			});
			$(await store.finishPoll(poll.id, workerId, {cursor: poll.cursor, nextAt, error: describeFailure(changed.error), matches: []}));
			return;
		}
		$(
			await store.logPoll({
				orgId: target.connection.orgId,
				connectionId: poll.connectionId,
				collectionId: poll.collectionId,
				action: 'list',
				recordTitle: null,
				ownerUserId: target.connection.ownerUserId,
				userId: null,
			}),
		);
		const items = changed.value.items.map((item) => ({...item, summary: itemSummary(item)}));
		const found = await matchesFor(store, rules, items, poll);
		$(await store.finishPoll(poll.id, workerId, {cursor: changed.value.cursor, nextAt, error: null, matches: found}));
	});
}
