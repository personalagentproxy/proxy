import {mcpConnectRoutes} from '../mcp/mcp-connect';
import {getNotionAccount, NOTION} from './notion-mcp';

/**
 * Connecting Notion by signing in to it, through its MCP server, as Granola is. A new Notion
 * connection lets agents read its pages by default; creating and editing are turned on on the
 * connection's page.
 */
export const {handleStart: handleStartNotionRoute, handleCallback: handleNotionCallbackRoute} = mcpConnectRoutes({
	integrationId: 'notion',
	server: NOTION,
	defaults: ['read'],
	account: getNotionAccount,
});
