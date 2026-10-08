import express from 'express';

import {handleListActivityRoute} from '../activity/route';
import {handleAgentLoginRoute, handleAgentLogoutRoute} from '../agent-auth/session';
import {handleAgentListToolsRoute, handleAgentMeRoute, handleAgentRunToolRoute} from '../agent-side/route';
import {
	handleCreateAgentRoute,
	handleDeleteAgentRoute,
	handleDisconnectMcpClientRoute,
	handleGetAgentRoute,
	handleListAgentsRoute,
	handleListMcpClientsRoute,
	handleResetAgentPasswordRoute,
	handleSetAgentGrantsRoute,
	handleSetAgentRevokedRoute,
} from '../agents/route';
import {handleDevLoginRoute} from '../auth/dev-login';
import {handleEmailSignInRoute, handleEmailVerifyRoute} from '../auth/email';
import {handleGoogleCallbackRoute, handleGoogleStartRoute, handleSignInMethodsRoute} from '../auth/google';
import {handleSignOutRoute} from '../auth/signout';
import {handleConnectEmailRoute} from '../connections/email/route';
import {handleGranolaCallbackRoute, handleStartGranolaRoute} from '../connections/granola/route';
import {handleLinearCallbackRoute, handleStartLinearRoute} from '../connections/linear/route';
import {handleNotionCallbackRoute, handleStartNotionRoute} from '../connections/notion/route';
import {handleDeleteConnectionRoute, handleGetConnectionRoute, handleListConnectionsRoute, handleSetConnectionDefaultsRoute} from '../connections/route';
import {handleMcpMethodNotAllowedRoute, handleMcpRoute} from '../mcp/route';
import {handleMeRoute} from '../me/route';
import {handleAuthorizeRoute, handleConsentRoute, handleGetAuthorizationRequestRoute} from '../oauth/authorize';
import {handleAuthorizationServerMetadataRoute, handleProtectedResourceMetadataRoute} from '../oauth/metadata';
import {handleRegisterClientRoute} from '../oauth/register';
import {handleTokenRoute} from '../oauth/token';
import {handleCreateRecordRoute, handleDeleteRecordRoute, handleGetRecordRoute, handleListRecordsRoute, handleUpdateRecordRoute} from '../records/route';
import {allowAnyOrigin} from './middleware/allow-any-origin';
import {requireBrowserOrigin} from './middleware/require-browser-origin';
import {withAgentAuthResult} from './middleware/require-agent';
import {withAuth, withAuthResult} from './middleware/require-auth';
import {wrapAsyncRoute} from './middleware/wrap-async-route';

export function createApiRouter(): express.Router {
	const router = express.Router();

	router.use(express.json({limit: '1mb'}));

	// Sign-in and sign-out. No auth middleware: these mint or revoke the session cookie, and
	// sign-out must succeed without a valid session. The OAuth endpoints and the magic-link verify
	// are top-level navigations (302 redirects); the magic-link send, sign-out and dev login are
	// writes from the web app, so they take the `requireBrowserOrigin` CSRF guard.
	router.get('/auth/methods', handleSignInMethodsRoute);
	router.get('/auth/google', wrapAsyncRoute('Google OAuth start route', handleGoogleStartRoute));
	router.get('/auth/google/callback', wrapAsyncRoute('Google OAuth callback route', handleGoogleCallbackRoute));
	router.post('/auth/email', requireBrowserOrigin, wrapAsyncRoute('Email sign-in route', handleEmailSignInRoute));
	router.get('/auth/email/verify', wrapAsyncRoute('Email verify route', handleEmailVerifyRoute));
	router.post('/auth/signout', requireBrowserOrigin, wrapAsyncRoute('Sign-out route', handleSignOutRoute));
	router.post('/auth/dev/login', requireBrowserOrigin, wrapAsyncRoute('Dev login route', handleDevLoginRoute));

	router.use('/api/me', requireBrowserOrigin);
	router.get('/api/me', withAuthResult('Me route', handleMeRoute));

	router.use('/api/connections', requireBrowserOrigin);
	router.get('/api/connections', withAuthResult('List connections route', handleListConnectionsRoute));
	router.post('/api/connections/email', withAuthResult('Connect email route', handleConnectEmailRoute));
	router.get('/api/connections/granola/start', withAuth('Start Granola sign-in route', handleStartGranolaRoute));
	router.get('/api/connections/granola/callback', withAuth('Granola sign-in callback route', handleGranolaCallbackRoute));
	router.get('/api/connections/notion/start', withAuth('Start Notion sign-in route', handleStartNotionRoute));
	router.get('/api/connections/notion/callback', withAuth('Notion sign-in callback route', handleNotionCallbackRoute));
	router.get('/api/connections/linear/start', withAuth('Start Linear sign-in route', handleStartLinearRoute));
	router.get('/api/connections/linear/callback', withAuth('Linear sign-in callback route', handleLinearCallbackRoute));
	router.get('/api/connections/:connectionId', withAuthResult('Get connection route', handleGetConnectionRoute));
	router.delete('/api/connections/:connectionId', withAuthResult('Delete connection route', handleDeleteConnectionRoute));
	router.put('/api/connections/:connectionId/defaults', withAuthResult('Set connection defaults route', handleSetConnectionDefaultsRoute));
	const records = '/api/connections/:connectionId/collections/:collectionId/records';
	router.get(records, withAuthResult('List records route', handleListRecordsRoute));
	router.post(records, withAuthResult('Create record route', handleCreateRecordRoute));
	router.get(`${records}/:recordId`, withAuthResult('Get record route', handleGetRecordRoute));
	router.put(`${records}/:recordId`, withAuthResult('Update record route', handleUpdateRecordRoute));
	router.delete(`${records}/:recordId`, withAuthResult('Delete record route', handleDeleteRecordRoute));

	router.use('/api/agents', requireBrowserOrigin);
	router.get('/api/agents', withAuthResult('List agents route', handleListAgentsRoute));
	router.post('/api/agents', withAuthResult('Create agent route', handleCreateAgentRoute));
	router.get('/api/agents/:agentId', withAuthResult('Get agent route', handleGetAgentRoute));
	router.delete('/api/agents/:agentId', withAuthResult('Delete agent route', handleDeleteAgentRoute));
	router.post('/api/agents/:agentId/password', withAuthResult('Reset agent password route', handleResetAgentPasswordRoute));
	router.put('/api/agents/:agentId/revoked', withAuthResult('Set agent revoked route', handleSetAgentRevokedRoute));
	router.put('/api/agents/:agentId/grants/:connectionId', withAuthResult('Set agent grants route', handleSetAgentGrantsRoute));
	router.get('/api/agents/:agentId/mcp-clients', withAuthResult('List MCP clients route', handleListMcpClientsRoute));
	router.delete('/api/agents/:agentId/mcp-clients/:grantId', withAuthResult('Disconnect MCP client route', handleDisconnectMcpClientRoute));

	router.use('/api/activity', requireBrowserOrigin);
	router.get('/api/activity', withAuthResult('List activity route', handleListActivityRoute));

	// The agent side: its own sign-in and cookie, and every request checked against the agent's
	// access and logged.
	router.post('/agent-auth/login', requireBrowserOrigin, wrapAsyncRoute('Agent login route', handleAgentLoginRoute));
	router.post('/agent-auth/logout', requireBrowserOrigin, wrapAsyncRoute('Agent logout route', handleAgentLogoutRoute));
	router.use('/api/agent', requireBrowserOrigin);
	router.get('/api/agent/me', withAgentAuthResult('Agent me route', handleAgentMeRoute));
	router.get('/api/agent/connections/:connectionId/tools', withAgentAuthResult('Agent list tools route', handleAgentListToolsRoute));
	router.post('/api/agent/connections/:connectionId/tools/:toolName', withAgentAuthResult('Agent run tool route', handleAgentRunToolRoute));

	// MCP clients such as Claude, ChatGPT and Poke: the MCP server, signed in with OAuth 2.1, where
	// Personal Agent Proxy is its own authorization server. Clients find it from the MCP server's
	// 401, register themselves, and send the person to /oauth/authorize, which hands over to the web
	// app's consent page; the person's answer is a write from the web app, so it takes the CSRF guard.
	router.use(['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/mcp'], allowAnyOrigin);
	router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], handleProtectedResourceMetadataRoute);
	router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], handleAuthorizationServerMetadataRoute);
	router.post('/oauth/register', wrapAsyncRoute('OAuth register route', handleRegisterClientRoute));
	router.get('/oauth/authorize', wrapAsyncRoute('OAuth authorize route', handleAuthorizeRoute));
	router.post('/oauth/token', express.urlencoded({extended: false}), wrapAsyncRoute('OAuth token route', handleTokenRoute));
	router.use('/api/oauth', requireBrowserOrigin);
	router.get('/api/oauth/request', withAuthResult('OAuth request route', handleGetAuthorizationRequestRoute));
	router.post('/api/oauth/consent', withAuthResult('OAuth consent route', handleConsentRoute));
	router.post('/mcp', wrapAsyncRoute('MCP route', handleMcpRoute));
	router.get('/mcp', handleMcpMethodNotAllowedRoute);
	router.delete('/mcp', handleMcpMethodNotAllowedRoute);

	// A body that isn't JSON: JSON-RPC's parse error for the MCP server, Express's own answer elsewhere.
	router.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (req.path !== '/mcp') {
			next(error);
			return;
		}
		res.status(400).json({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}});
	});

	return router;
}
