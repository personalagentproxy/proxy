import type {ConnectionRow} from '@proxy/db/connection';
import {findIntegration} from '@proxy/integrations';

export type ConnectionResponse = {
	id: string;
	integrationId: string;
	account: string;
	connectedAt: string;
	// Per collection, the actions an agent without a setting of its own gets. The catalog says
	// which actions there are; an agent's own settings live on the agent.
	collections: Array<{id: string; defaults: string[]}>;
};

export function toConnectionResponse(row: ConnectionRow): ConnectionResponse {
	const collections = findIntegration(row.integrationId)?.collections ?? [];
	return {
		id: row.id,
		integrationId: row.integrationId,
		account: row.account,
		connectedAt: row.createdAt.toISOString(),
		collections: collections.map((collection) => ({
			id: collection.id,
			defaults: collection.actions.map((action) => action.id).filter((actionId) => row.defaults.some((stored) => stored.collectionId === collection.id && stored.actionId === actionId)),
		})),
	};
}
