import type {ApiIntegration} from '../integration';
import {handleConnectCustomMcpRoute, handleCustomMcpCallbackRoute} from './route';

/**
 * A custom MCP server, by its address: connected at once, or signed in to where it asks. It has no
 * records: its tools are called as they are, each an action of the connection's own.
 */
export const CUSTOM_MCP_INTEGRATION: ApiIntegration = {
	id: 'mcp',
	connectors: {},
	connect: {kind: 'server', name: 'custom MCP server', routes: () => ({handleConnect: handleConnectCustomMcpRoute, handleCallback: handleCustomMcpCallbackRoute})},
};
