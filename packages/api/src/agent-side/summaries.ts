import {findIntegration, integrationFor, type Tool} from '@proxy/integrations';
import type {AgentConnection} from '@proxy/contracts/agent-side';

/**
 * Connections and tools as an agent is given them, by `pap.connections()` and `pap.tools()` in a
 * script and in the instructions it is given when it connects.
 */

// "Read, Archive, Send": what the actions are called, in the catalog's order; a custom server's
// tools by their titles.
export function describeActions(connection: AgentConnection): string {
	const integration = integrationFor(connection);
	return (integration?.actions ?? [])
		.filter((action) => connection.actions.includes(action.id))
		.map((action) => action.label)
		.join(', ');
}

/** A connection by its integration, and the name the person gave it where they did. */
export function connectionSummary(connection: AgentConnection) {
	return {
		connection: connection.id,
		integration: findIntegration(connection.integrationId)?.name ?? connection.integrationId,
		...(connection.name === null ? {} : {name: connection.name}),
		account: connection.account,
		shared: connection.shared,
		can: describeActions(connection),
	};
}

/** A tool: what it does, and its params as JSON Schema. */
export function toolSummary(tool: Tool) {
	return {name: tool.name, description: tool.description, params: tool.inputSchema};
}
