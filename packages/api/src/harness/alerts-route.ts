import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {type ApiError, ApiErr, Do} from '@proxy/utils';
import {parseCriteria} from '@proxy/utils/alerts';
import {toAvatarColor} from '@proxy/utils/harness';
import type {ConnectionRow} from '@proxy/db/connection';
import type {ListedAlert} from '@proxy/db/harness';
import type {PollRow} from '@proxy/db/poll';
import {findIntegration} from '@proxy/integrations';
import type {Alert, alertListSchema} from '@proxy/contracts/alerts';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireChat} from './route';
import type {HarnessStore} from './store';

/**
 * The Alerts page's routes, under the organization: the member's own alerts, those the agents
 * they talk with on the Chat page set in their conversations, going and ended, each with the
 * connections it watches and its latest matches, and deleting one. Behind the `harness`
 * experiment, as the Chat page is. Nothing here sets an alert: the agent does, asked to in its
 * conversation (tool-job.ts).
 */

/** What the Alerts page's routes need of the store. */
export type AlertsStore = Pick<HarnessStore, 'listMemberAlerts' | 'listPolls' | 'listConnectionsByIds' | 'deleteAlert'>;

// What the person calls the connection, or the integration and the account.
function called(connection: ConnectionRow): string {
	return connection.name ?? `${findIntegration(connection.integrationId)?.name ?? connection.integrationId} (${connection.account})`;
}

function toAlert(alert: ListedAlert, connections: Map<string, ConnectionRow>, polls: PollRow[]): Alert {
	const at = (date: Date | null) => date?.toISOString() ?? null;
	const own = polls.filter((poll) => poll.collectionId === alert.collectionId && alert.connectionIds.includes(poll.connectionId));
	const polled = own.map((poll) => poll.lastPolledAt?.getTime() ?? 0).filter((time) => time > 0);
	return {
		id: alert.id,
		title: alert.title,
		brief: alert.brief,
		persona: {id: alert.persona.id, name: alert.persona.name, look: alert.persona.look, color: toAvatarColor(alert.persona.color)},
		at: at(alert.at),
		collectionId: alert.collectionId,
		criteria: parseCriteria(alert.criteria),
		connections: alert.connectionIds.flatMap((id) => {
			const connection = connections.get(id);
			return connection ? [{id, name: called(connection)}] : [];
		}),
		lastPolledAt: polled.length > 0 ? new Date(Math.max(...polled)).toISOString() : null,
		pollError: own.find((poll) => poll.lastError !== null)?.lastError ?? null,
		matchCount: alert.matchCount,
		matches: alert.matches.map((match) => ({id: match.id, title: match.title, summary: match.summary, url: match.url, at: match.createdAt.toISOString()})),
		endedAt: at(alert.endedAt),
		endedBy: alert.endedBy,
		createdAt: alert.createdAt.toISOString(),
	};
}

/** `GET /api/orgs/:org/alerts`: the viewer's alerts in the organization, newest first, each with the persona it was set with, the connections it watches and its latest matches. */
function handleListAlertsRoute(store: AlertsStore, request: AuthenticatedRequest): Promise<Result<z.infer<typeof alertListSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const alerts = $(await store.listMemberAlerts(viewer.orgId, viewer.userId));
		const ids = [...new Set(alerts.flatMap((alert) => alert.connectionIds))];
		const [connections, polls] = await Promise.all([store.listConnectionsByIds(viewer.orgId, ids), store.listPolls(viewer.orgId)]);
		const byId = new Map($(connections).map((connection) => [connection.id, connection]));
		const listed = $(polls);
		return {alerts: alerts.map((alert) => toAlert(alert, byId, listed))};
	});
}

/** `DELETE /api/orgs/:org/alerts/:alertId`: one of the viewer's alerts, going or ended, with its matches; nothing more comes of it. */
function handleDeleteAlertRoute(store: AlertsStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const alertId = request.params.alertId ?? '';
		if (!$(await store.deleteAlert(viewer.orgId, viewer.userId, alertId))) {
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
