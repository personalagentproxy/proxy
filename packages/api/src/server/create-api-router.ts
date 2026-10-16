import express from 'express';

import {handleActivitySummaryRoute, handleListActivityRoute} from '../activity/route';
import {handleAgentLoginRoute, handleAgentLogoutRoute} from '../agent-auth/session';
import {handleAgentFeedbackRoute, handleAgentListToolsRoute, handleAgentMeRoute, handleAgentRunToolRoute} from '../agent-side/route';
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
import {handleConnectCustomMcpRoute, handleCustomMcpCallbackRoute, handleRefreshCustomMcpToolsRoute} from '../connections/custom/route';
import {handleConnectEmailRoute, handleTestEmailRoute} from '../connections/email/route';
import {handleGoogleCallbackRoute as handleConnectGoogleCallbackRoute, handleStartGoogleRoute} from '../connections/google/route';
import {handleGranolaCallbackRoute, handleStartGranolaRoute} from '../connections/granola/route';
import {handleLinearCallbackRoute, handleStartLinearRoute} from '../connections/linear/route';
import {handleConnectMysqlRoute, handleTestMysqlRoute} from '../connections/mysql/route';
import {handleNotionCallbackRoute, handleStartNotionRoute} from '../connections/notion/route';
import {handleConnectPlaidRoute, handleCreatePlaidLinkTokenRoute} from '../connections/plaid/route';
import {handleConnectPostgresRoute, handleTestPostgresRoute} from '../connections/postgres/route';
import {handleDeleteConnectionRoute, handleGetConnectionRoute, handleListConnectionsRoute, handleRenameConnectionRoute, handleSetConnectionDefaultsRoute} from '../connections/route';
import {handleClassifyIntentRoute} from '../intent/route';
import {handleMcpMethodNotAllowedRoute, handleMcpRoute} from '../mcp/route';
import {handleDeleteMeRoute, handleFinishOnboardingRoute, handleMeRoute} from '../me/route';
import {handleAuthorizeRoute, handleConsentRoute, handleGetAuthorizationRequestRoute} from '../oauth/authorize';
import {handleAuthorizationServerMetadataRoute, handleProtectedResourceMetadataRoute} from '../oauth/metadata';
import {handleRegisterClientRoute} from '../oauth/register';
import {handleTokenRoute} from '../oauth/token';
import {handleCreateRecordRoute, handleDeleteRecordRoute, handleGetRecordRoute, handleListRecordsRoute, handleUpdateRecordRoute} from '../records/route';
import {handleAgendaRoute} from '../widgets/agenda';
import {handleFindEmailsRoute, handleMailboxesRoute, handleWriteEmailRoute} from '../widgets/emails';
import {handleFindFilesRoute} from '../widgets/files';
import {handleCreateEventRoute} from '../widgets/new-event';
import {handlePeopleRoute} from '../widgets/people';
import {handleRatesRoute} from '../widgets/rates';
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
	router.post('/api/me/onboarded', withAuthResult('Finish onboarding route', handleFinishOnboardingRoute));
	router.delete('/api/me', withAuth('Delete account route', handleDeleteMeRoute));

	router.use('/api/connections', requireBrowserOrigin);
	router.get('/api/connections', withAuthResult('List connections route', handleListConnectionsRoute));
	router.post('/api/connections/email', withAuthResult('Connect email route', handleConnectEmailRoute));
	router.post('/api/connections/email/test', withAuthResult('Test email route', handleTestEmailRoute));
	router.get('/api/connections/google/start', withAuth('Start Google sign-in route', handleStartGoogleRoute));
	router.get('/api/connections/google/callback', withAuth('Google sign-in callback route', handleConnectGoogleCallbackRoute));
	router.get('/api/connections/granola/start', withAuth('Start Granola sign-in route', handleStartGranolaRoute));
	router.get('/api/connections/granola/callback', withAuth('Granola sign-in callback route', handleGranolaCallbackRoute));
	router.get('/api/connections/notion/start', withAuth('Start Notion sign-in route', handleStartNotionRoute));
	router.get('/api/connections/notion/callback', withAuth('Notion sign-in callback route', handleNotionCallbackRoute));
	router.get('/api/connections/linear/start', withAuth('Start Linear sign-in route', handleStartLinearRoute));
	router.get('/api/connections/linear/callback', withAuth('Linear sign-in callback route', handleLinearCallbackRoute));
	router.post('/api/connections/plaid', withAuthResult('Connect Plaid route', handleConnectPlaidRoute));
	router.post('/api/connections/plaid/link-token', withAuthResult('Create Plaid Link token route', handleCreatePlaidLinkTokenRoute));
	router.post('/api/connections/postgres', withAuthResult('Connect Postgres route', handleConnectPostgresRoute));
	router.post('/api/connections/postgres/test', withAuthResult('Test Postgres route', handleTestPostgresRoute));
	router.post('/api/connections/mysql', withAuthResult('Connect MySQL route', handleConnectMysqlRoute));
	router.post('/api/connections/mysql/test', withAuthResult('Test MySQL route', handleTestMysqlRoute));
	router.post('/api/connections/mcp', withAuth('Connect custom MCP server route', handleConnectCustomMcpRoute));
	router.get('/api/connections/mcp/callback', withAuth('Custom MCP server sign-in callback route', handleCustomMcpCallbackRoute));
	router.get('/api/connections/:connectionId', withAuthResult('Get connection route', handleGetConnectionRoute));
	router.delete('/api/connections/:connectionId', withAuthResult('Delete connection route', handleDeleteConnectionRoute));
	router.put('/api/connections/:connectionId/defaults', withAuthResult('Set connection defaults route', handleSetConnectionDefaultsRoute));
	router.put('/api/connections/:connectionId/name', withAuthResult('Rename connection route', handleRenameConnectionRoute));
	router.post('/api/connections/:connectionId/tools', withAuthResult('Refresh custom MCP server tools route', handleRefreshCustomMcpToolsRoute));
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
	router.get('/api/activity/summary', withAuthResult('Activity summary route', handleActivitySummaryRoute));

	// The home page: which widget fits what the person types, and the entities in it.
	router.use('/api/intent', requireBrowserOrigin);
	router.post('/api/intent', withAuthResult('Classify intent route', handleClassifyIntentRoute));
	// Its widgets: every connection with the collection a widget is about, read at once, and
	// written to as the person picks.
	router.use('/api/widgets', requireBrowserOrigin);
	router.get('/api/widgets/people', withAuthResult('Widget people route', handlePeopleRoute));
	router.get('/api/widgets/agenda', withAuthResult('Widget agenda route', handleAgendaRoute));
	router.post('/api/widgets/events', withAuthResult('Widget create event route', handleCreateEventRoute));
	router.get('/api/widgets/emails', withAuthResult('Widget find emails route', handleFindEmailsRoute));
	router.post('/api/widgets/emails', withAuthResult('Widget write email route', handleWriteEmailRoute));
	router.get('/api/widgets/mailboxes', withAuthResult('Widget mailboxes route', handleMailboxesRoute));
	router.get('/api/widgets/files', withAuthResult('Widget find files route', handleFindFilesRoute));
	router.get('/api/widgets/rates', withAuthResult('Widget exchange rates route', handleRatesRoute));

	// The agent side: its own sign-in and cookie, and every request checked against the agent's
	// access and logged.
	router.post('/agent-auth/login', requireBrowserOrigin, wrapAsyncRoute('Agent login route', handleAgentLoginRoute));
	router.post('/agent-auth/logout', requireBrowserOrigin, wrapAsyncRoute('Agent logout route', handleAgentLogoutRoute));
	router.use('/api/agent', requireBrowserOrigin);
	router.get('/api/agent/me', withAgentAuthResult('Agent me route', handleAgentMeRoute));
	router.get('/api/agent/connections/:connectionId/tools', withAgentAuthResult('Agent list tools route', handleAgentListToolsRoute));
	router.post('/api/agent/connections/:connectionId/tools/:toolName', withAgentAuthResult('Agent run tool route', handleAgentRunToolRoute));
	router.post('/api/agent/feedback', withAgentAuthResult('Agent feedback route', handleAgentFeedbackRoute));

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
