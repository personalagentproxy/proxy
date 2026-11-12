import type {ApiIntegration} from '../integration';
import {handleConnectCustomMcpRoute, handleCustomMcpCallbackRoute} from './route';
import {listCustomTools} from './custom-mcp';

/**
 * A custom MCP server, by its address: connected at once, or signed in to where it asks. It has no
 * records: its tools are called as they are, each an action of the connection's own.
 */
export const CUSTOM_MCP_INTEGRATION: ApiIntegration = {
	id: 'mcp',
	connectors: {},
	check: async (connection) => (await listCustomTools(connection)).map(() => undefined),
	connect: {kind: 'server', name: 'custom MCP server', routes: () => ({handleConnect: handleConnectCustomMcpRoute, handleCallback: handleCustomMcpCallbackRoute})},
};
