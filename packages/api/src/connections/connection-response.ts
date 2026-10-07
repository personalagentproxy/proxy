import type {ConnectionRow} from '@proxy/db/connection';
import {findIntegration} from '@proxy/integrations';

export type ConnectionResponse = {
	id: string;
	integrationId: string;
	account: string;
	connectedAt: string;
	// The actions an agent without a setting of its own gets, in the catalog's order. An agent's own
	// settings live on the agent.
	defaults: string[];
};

export function toConnectionResponse(row: ConnectionRow): ConnectionResponse {
	const actions = findIntegration(row.integrationId)?.actions ?? [];
	return {
		id: row.id,
		integrationId: row.integrationId,
		account: row.account,
		connectedAt: row.createdAt.toISOString(),
		defaults: actions.map((action) => action.id).filter((id) => row.defaults.some((stored) => stored.actionId === id)),
	};
}
