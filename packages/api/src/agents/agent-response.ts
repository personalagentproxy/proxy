import type {AgentRow} from '@proxy/db/agent';

export type AgentResponse = {
	id: string;
	name: string;
	username: string;
	createdAt: string;
	lastActiveAt: string | null;
	revokedAt: string | null;
	// One per action where the agent has a setting of its own; every other action follows the
	// connection's default.
	grants: Array<{connectionId: string; collectionId: string; actionId: string; allowed: boolean}>;
};

export function toAgentResponse(row: AgentRow): AgentResponse {
	return {
		id: row.id,
		name: row.name,
		username: row.username,
		createdAt: row.createdAt.toISOString(),
		lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
		revokedAt: row.revokedAt?.toISOString() ?? null,
		grants: row.grants,
	};
}
