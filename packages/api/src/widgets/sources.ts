import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {listConnectionsWithCredential} from '@proxy/db/connection';
import type {Viewer} from '@proxy/db/viewer';
import {findCollection, requiredAction, type Collection, type Integration} from '@proxy/integrations';

import {unavailableActions, unavailableError} from '../connections/unavailable';
import type {Capabilities, Capability} from '../records/capabilities';
import {isRecordStore, type RecordStore, type RecordTarget} from '../records/connector';
import {connectorFor} from '../records/connectors';
import {loadRecordTarget} from '../records/target';
import {integrationOf} from '../utils/connection-actions';

/**
 * Where the home page's widgets read and write: every connection the person sees in the
 * organization, its shared ones and their own, with a collection of the kind a widget is about, as the catalog names it (`events`, `contacts`,
 * `emails`, `files`). A collection's id is the contract: every integration with an `emails`
 * collection has the same fields, so a widget works with any of them, and connecting a new
 * integration with the collection lights the widget up. What a widget does beyond listing and
 * writing records, such as searching mail, is a capability of the collection's connector, which
 * every connector of the collection may offer. The person owns the connections, so nothing limits
 * them but what the sign-in covered.
 */

// Every collection a widget is about keeps its records, so a source's connector lists and opens them.
export type Source = RecordTarget & {integration: Integration; connector: RecordStore};

/** A source whose connector has the capability. */
export type Capable<C extends Capability> = Source & {connector: Required<Pick<Capabilities, C>>};

function offers<C extends Capability>(connector: RecordStore, capability: C): connector is RecordStore & Required<Pick<Capabilities, C>> {
	return connector[capability] !== undefined;
}

/** The sources whose connector has the capability, as the Find email widget keeps the mailboxes that can be searched. */
export function withCapability<C extends Capability>(sources: Source[], capability: C): Array<Capable<C>> {
	return sources.flatMap((source) => {
		const {connector} = source;
		return offers(connector, capability) ? [{...source, connector}] : [];
	});
}

/** What the browser is told of a source: which account it is, to tell several apart. */
export type SourceSummary = {connectionId: string; integrationId: string; account: string; name: string | null};

export function summarize(source: Source): SourceSummary {
	const {id, integrationId, account, name} = source.connection;
	return {connectionId: id, integrationId, account, name};
}

/**
 * The connections the viewer sees with the collection, where its sign-in covered `request`: `list`
 * to read it, `create` to write to it, or a command's id, such as `sendNew`.
 */
export function findSources(viewer: Viewer, collectionId: string, request: string): Promise<Result<Source[], ApiError>> {
	return Do(async ($) => {
		const connections = $(await listConnectionsWithCredential(viewer));
		return connections.flatMap((connection): Source[] => {
			const integration = integrationOf(connection);
			const collection = integration ? findCollection(integration, collectionId) : undefined;
			const connector = connectorFor(connection.integrationId, collectionId);
			if (!integration || !collection || !connector || !isRecordStore(connector) || !covers(connection, collection, request)) {
				return [];
			}
			return [{connection, collection, integration, connector}];
		});
	});
}

/** Whether the connection's sign-in covered `request` of the collection: `view` to read it, `create` to write to it, or a command's id. */
export function covers(connection: {id: string; integrationId: string; credential: string | null}, collection: Collection, request: string): boolean {
	const action = requiredAction(collection, request);
	return action !== null && !unavailableActions(connection).includes(action);
}

/**
 * One connection to write to, with the collection: `request` is `create` or a command's id, such
 * as `sendNew`, and `fields` the fields written, some of which need an action of their own, as an
 * event's guests need Invite guests. One whose sign-in didn't cover them all is refused, saying so.
 */
export function requireWritable(viewer: Viewer, connectionId: string, collectionId: string, request: string, fields: string[]): Promise<Result<Source, ApiError>> {
	return requireCovered(viewer, connectionId, collectionId, request, fields);
}

/** One connection to read, with the collection; one whose sign-in didn't cover reading it is refused, saying so. */
export function requireReadable(viewer: Viewer, connectionId: string, collectionId: string): Promise<Result<Source, ApiError>> {
	return requireCovered(viewer, connectionId, collectionId, 'view', []);
}

function requireCovered(viewer: Viewer, connectionId: string, collectionId: string, request: string, fields: string[]): Promise<Result<Source, ApiError>> {
	return Do(async ($) => {
		const target = $(await loadRecordTarget(viewer, connectionId, collectionId));
		const {connector} = target;
		const integration = integrationOf(target.connection);
		const action = requiredAction(target.collection, request);
		if (!integration || action === null || !isRecordStore(connector)) {
			return $(Err(ApiErr.forbidden()));
		}
		const fieldActions = target.collection.fields.flatMap((field) => (field.action && fields.includes(field.key) ? [field.action] : []));
		const unavailable = unavailableActions(target.connection);
		const missing = [action, ...fieldActions].find((needed) => unavailable.includes(needed));
		if (missing !== undefined) {
			return $(Err(unavailableError(integration, missing)));
		}
		return {...target, connector, integration};
	});
}
