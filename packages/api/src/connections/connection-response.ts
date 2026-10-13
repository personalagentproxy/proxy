import type {ConnectionRow} from '@proxy/db/connection';
import type {McpTool} from '@proxy/integrations';

import {integrationOf, parseStoredTools} from '../utils/connection-actions';

export type ConnectionResponse = {
	id: string;
	integrationId: string;
	account: string;
	// The actions an agent without a setting of its own gets, in the catalog's order. An agent's own
	// settings live on the agent.
	defaults: string[];
	// A custom MCP server's tools, as the server last listed them: what its actions are. Null for
	// every other integration.
	tools: McpTool[] | null;
};

export function toConnectionResponse(row: ConnectionRow): ConnectionResponse {
	const actions = integrationOf(row)?.actions ?? [];
	return {
		id: row.id,
		integrationId: row.integrationId,
		account: row.account,
		defaults: actions.map((action) => action.id).filter((id) => row.defaults.some((stored) => stored.actionId === id)),
		tools: parseStoredTools(row.tools),
	};
}
