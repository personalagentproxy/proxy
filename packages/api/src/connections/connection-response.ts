import type {ConnectionRow} from '@proxy/db/connection';
import {findIntegration, providerAccess, type Access} from '@proxy/integrations';

export type ConnectionResponse = {
	id: string;
	integrationId: string;
	account: string;
	connectedAt: string;
	// Two of the three access layers, per collection: what the provider allows and what an agent
	// without a setting of its own gets. The third lives on each agent.
	collections: Array<{id: string; provider: Access; connectionDefault: Access}>;
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
			provider: providerAccess(collection),
			connectionDefault: row.defaults.find((stored) => stored.collectionId === collection.id)?.access ?? 'none',
		})),
	};
}
