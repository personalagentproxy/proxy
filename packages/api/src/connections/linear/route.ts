import {mcpConnectRoutes} from '../mcp/mcp-connect';
import {getLinearAccount, LINEAR} from './linear-mcp';

/**
 * Connecting Linear by signing in to it, through its MCP server, as Granola and Notion are. A new
 * Linear connection lets agents read its issues by default; creating and editing are turned on on
 * the connection's page.
 */
export const {handleStart: handleStartLinearRoute, handleCallback: handleLinearCallbackRoute} = mcpConnectRoutes({
	integrationId: 'linear',
	server: LINEAR,
	defaults: ['read'],
	account: getLinearAccount,
});
