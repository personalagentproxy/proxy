import {findIntegration} from '@proxy/integrations';

import {mcpConnectRoutes} from '../mcp/mcp-connect';
import {GRANOLA, getGranolaAccount} from './granola-mcp';

/**
 * Connecting Granola by signing in to it, as its MCP server asks. A new Granola connection lets
 * agents read both its notes and its transcripts by default; either can be turned off on the
 * connection's page.
 */
export const {handleStart: handleStartGranolaRoute, handleCallback: handleGranolaCallbackRoute} = mcpConnectRoutes({
	integrationId: 'granola',
	server: GRANOLA,
	defaults: findIntegration('granola')?.actions.map((action) => action.id) ?? [],
	account: (signIn) => getGranolaAccount(signIn.credential.accessToken),
});
