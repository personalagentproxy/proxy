import type {AgentRow} from '@proxy/db/agent';
import type {Access} from '@proxy/integrations';

export type AgentResponse = {
	id: string;
	name: string;
	username: string;
	createdAt: string;
	lastActiveAt: string | null;
	revokedAt: string | null;
	// Only where the agent differs from the connection's default.
	grants: Array<{connectionId: string; collectionId: string; access: Access}>;
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
