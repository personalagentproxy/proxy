import {Ok} from 'ts-results-es';

import {logProxyAction} from '@proxy/db/audit';
import {saveWriteTarget} from '@proxy/db/write-target';

import {log} from '../observability/log';
import type {Source} from './sources';

/**
 * What follows a widget's write: the activity log's entry, as done by Personal Agent Proxy for the
 * person rather than by an agent, naming them, and the place written to, which the widget starts on next time,
 * unless `parent` is `undefined`, as for a change to something already there, which picks nowhere.
 * The write is done by then, so neither failing fails it; each is logged instead.
 */
export async function afterWrite(args: {orgId: string; userId: string; source: Source; action: string; title: string; parent: string | null | undefined}): Promise<void> {
	const {orgId, userId, source, action, title, parent} = args;
	const connectionId = source.connection.id;
	const collectionId = source.collection.id;
	const [logged, saved] = await Promise.all([
		logProxyAction({orgId, connectionId, collectionId, action, recordTitle: title || null, ownerUserId: source.connection.ownerUserId, userId}),
		parent === undefined ? Ok(null) : saveWriteTarget({userId, collectionId, connectionId, parent}),
	]);
	if (logged.isErr()) {
		log.warn('A widget’s write could not be logged', {connectionId, collectionId, action});
	}
	if (saved.isErr()) {
		log.warn('Where a widget wrote could not be kept', {connectionId, collectionId});
	}
}
