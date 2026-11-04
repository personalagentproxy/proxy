import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {POLL_EVERY_MS} from '@proxy/utils/alerts';
import type {PollRow} from '@proxy/db/poll';
import {findCollection} from '@proxy/integrations';

import {log, serializeError} from '../observability/log';
import {isRecordStore, type Changes, type RecordTarget} from '../records/connector';
import {connectorFor} from '../records/connectors';
import {integrationOf} from '../utils/connection-actions';
import {describeFailure} from '../utils/describe-failure';
import type {PollConsumer} from './consumer';
import type {PollStore} from './store';

/**
 * One look: the connection's collection, asked for what is new or changed since the last look,
 * as its connector tells it (`changes`), handed to every consumer that wants it, then the poll
 * finished with where the look left off, so the next starts there. The look is logged as
 * Personal Agent Proxy's own, as a widget's read is. A poll no consumer wants deletes itself; one
 * whose connection is gone, or whose integration doesn't poll the collection, tells the consumers
 * and deletes itself. A look that fails is noted on the poll, for whoever shows it, and tried
 * again at the next; the cursor stays where it was. A consumer that fails is logged, and the
 * cursor stays too, so the look comes again.
 */

// How many consumers' failures a look logs before giving the rest up: none, all are tried.

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

// Whether any consumer wants the look.
async function wanted(consumers: PollConsumer[], poll: PollRow): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		for (const consumer of consumers) {
			if ($(await consumer.wants(poll))) {
				return true;
			}
		}
		return false;
	});
}

// Tells every consumer the connection is gone, and deletes the poll.
async function endPoll(store: PollStore, consumers: PollConsumer[], poll: PollRow): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		for (const consumer of consumers) {
			$(await consumer.connectionGone(poll));
		}
		$(await store.deletePoll(poll.id));
	});
}

/** Runs the poll: the look taken and handed to the consumers, and the next due; nothing when no consumer wants it. */
export function runPoll(store: PollStore, consumers: PollConsumer[], poll: PollRow, workerId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (!$(await wanted(consumers, poll))) {
			$(await store.deletePoll(poll.id));
			return;
		}
		const target = $(await pollTarget(store, poll));
		if (!target) {
			$(await endPoll(store, consumers, poll));
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
			$(await store.finishPoll(poll.id, workerId, {cursor: poll.cursor, nextAt, error: describeFailure(changed.error)}));
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
		for (const consumer of consumers) {
			$(await consumer.handle(poll, changed.value.items));
		}
		$(await store.finishPoll(poll.id, workerId, {cursor: changed.value.cursor, nextAt, error: null}));
	});
}
