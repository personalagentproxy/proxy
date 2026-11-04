import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {type ApiError, ApiErr, Do} from '@proxy/utils';
import {toAvatarColor} from '@proxy/utils/harness';
import type {AlertRow} from '@proxy/db/alerts';
import type {ConnectionRow} from '@proxy/db/connection';
import type {PersonaRow} from '@proxy/db/harness';
import type {Alert, alertListSchema} from '@proxy/contracts/alerts';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {connectionName, WATCHED_COLLECTIONS, type WatchedCollection} from './alerts';
import {requireChat} from './route';
import type {HarnessStore} from './store';

/**
 * The Alerts page's routes, under the organization: the member's own alerts, those the agents they
 * talk with on the Chat page set in their conversations, each with the connections it watches, and
 * deleting one. Behind the `harness` experiment, as the Chat page is. Nothing here sets an alert:
 * the agent does, asked to in its conversation (tool-job.ts).
 */

/** What the Alerts page's routes need of the store. */
export type AlertsStore = Pick<HarnessStore, 'listMemberAlerts' | 'listConnectionsByIds' | 'deleteAlert'>;

function toAlert(alert: AlertRow & {persona: PersonaRow}, connections: Map<string, ConnectionRow>): Alert {
	return {
		id: alert.id,
		title: alert.title,
		brief: alert.brief,
		persona: {id: alert.persona.id, name: alert.persona.name, look: alert.persona.look, color: toAvatarColor(alert.persona.color)},
		at: alert.at?.toISOString() ?? null,
		collection: alert.collectionId !== null && alert.collectionId in WATCHED_COLLECTIONS ? WATCHED_COLLECTIONS[alert.collectionId as WatchedCollection] : null,
		connections: alert.connectionIds.flatMap((id) => {
			const connection = connections.get(id);
			return connection ? [{id, name: connectionName(connection)}] : [];
		}),
		terms: alert.terms,
		createdAt: alert.createdAt.toISOString(),
	};
}

/** `GET /api/orgs/:org/alerts`: the viewer's alerts in the organization, newest first, each with the persona it was set with and the connections it watches. */
function handleListAlertsRoute(store: AlertsStore, request: AuthenticatedRequest): Promise<Result<z.infer<typeof alertListSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const alerts = $(await store.listMemberAlerts(viewer.orgId, viewer.userId));
		const ids = [...new Set(alerts.flatMap((alert) => alert.connectionIds))];
		const connections = new Map($(await store.listConnectionsByIds(viewer.orgId, ids)).map((connection) => [connection.id, connection]));
		return {alerts: alerts.map((alert) => toAlert(alert, connections))};
	});
}

/** `DELETE /api/orgs/:org/alerts/:alertId`: one of the viewer's alerts; nothing more comes of it. */
function handleDeleteAlertRoute(store: AlertsStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const alertId = request.params.alertId ?? '';
		if (!$(await store.deleteAlert(alertId, {orgId: viewer.orgId, userId: viewer.userId}))) {
			return $(Err(ApiErr.notFound('alert', alertId)));
		}
	});
}

/** The Alerts page's routes, on the store. */
export function alertRoutes(store: AlertsStore) {
	return {
		handleListAlertsRoute: (request: AuthenticatedRequest) => handleListAlertsRoute(store, request),
		handleDeleteAlertRoute: (request: AuthenticatedRequest) => handleDeleteAlertRoute(store, request),
	};
}
