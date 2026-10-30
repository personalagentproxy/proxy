import express from 'express';

import {handleActivityTimelineRoute, handleListActivityRoute, handleTaskRunRoute} from '../activity/route';
import {handleAgentLoginRoute, handleAgentLogoutRoute} from '../agent-auth/session';
import {
	handleAgentFeedbackRoute,
	handleAgentFinishTaskRoute,
	handleAgentGetTaskRoute,
	handleAgentListTasksRoute,
	handleAgentListToolsRoute,
	handleAgentMeRoute,
	handleAgentRunToolRoute,
	handleAgentStartTaskRoute,
} from '../agent-side/route';
import {
	handleCreateAgentRoute,
	handleDeleteAgentRoute,
	handleDisconnectMcpClientRoute,
	handleGetAgentRoute,
	handleListAgentsRoute,
	handleListMcpClientsRoute,
	handleRenameAgentRoute,
	handleResetAgentPasswordRoute,
	handleSetAgentGrantsRoute,
	handleSetAgentRevokedRoute,
	handleShareAgentRoute,
} from '../agents/route';
import {handleDevLoginRoute} from '../auth/dev-login';
import {handleEmailSignInRoute, handleEmailVerifyRoute} from '../auth/email';
import {handleGoogleCallbackRoute, handleGoogleStartRoute, handleSignInMethodsRoute} from '../auth/google';
import {handleSignOutRoute} from '../auth/signout';
import {handleRefreshCustomMcpToolsRoute} from '../connections/custom/route';
import type {ApiIntegration} from '../connections/integration';
import {apiIntegrations} from '../connections/integrations';
import {
	handleDeleteConnectionRoute,
	handleGetConnectionRoute,
	handleListConnectionsRoute,
	handleRenameConnectionRoute,
	handleSetConnectionDefaultsRoute,
	handleShareConnectionRoute,
} from '../connections/route';
import {handleFaviconRoute} from '../favicons/route';
import {chatRoutes} from '../harness/route';
import {harnessStore} from '../harness/store';
import {handleFillIntentRoute, handlePickIntentRoute} from '../intent/route';
import {handleMcpMethodNotAllowedRoute, handleMcpRoute} from '../mcp/route';
import {handleDeleteMeRoute, handleMeRoute} from '../me/route';
import {handleAcceptInvitationRoute, handleGetInvitationRoute} from '../orgs/invitation-link';
import {
	handleCreateOrgRoute,
	handleDeleteOrgRoute,
	handleFinishOnboardingRoute,
	handleGetOrgRoute,
	handleInviteRoute,
	handleLeaveOrgRoute,
	handleListMembersRoute,
	handleListOrgsRoute,
	handleRemoveMemberRoute,
	handleRenameOrgRoute,
	handleRevokeInvitationRoute,
} from '../orgs/route';
import {handleAuthorizeRoute, handleConsentRoute, handleGetAuthorizationRequestRoute} from '../oauth/authorize';
import {handleAuthorizationServerMetadataRoute, handleProtectedResourceMetadataRoute} from '../oauth/metadata';
import {handleRegisterClientRoute} from '../oauth/register';
import {handleTokenRoute} from '../oauth/token';
import {handleCreateRecordRoute, handleDeleteRecordRoute, handleGetRecordRoute, handleListRecordsRoute, handleUpdateRecordRoute} from '../records/route';
import {handleAgendaRoute, handleFindEventsRoute} from '../widgets/agenda';
import {handleAnswerRoute} from '../widgets/answer';
import {handleBankAccountsRoute, handleBankTransactionsRoute} from '../widgets/bank';
import {handleEditEventRoute} from '../widgets/edit-event';
import {handleFindEmailsRoute, handleMailboxesRoute, handleReplyEmailRoute, handleWriteEmailRoute} from '../widgets/emails';
import {handleFindFilesRoute} from '../widgets/files';
import {handleFindMeetingsRoute} from '../widgets/meetings';
import {handleCreateEventRoute} from '../widgets/new-event';
import {handlePeopleRoute} from '../widgets/people';
import {handleRatesRoute} from '../widgets/rates';
import {handleFindRecordsRoute} from '../widgets/records';
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
	router.delete('/api/me', withAuth('Delete account route', handleDeleteMeRoute));

	router.use('/api/orgs', requireBrowserOrigin);
	router.get('/api/orgs', withAuthResult('List organizations route', handleListOrgsRoute));
	router.post('/api/orgs', withAuthResult('Create organization route', handleCreateOrgRoute));

	router.use('/api/invitations', requireBrowserOrigin);
	router.get('/api/invitations/:token', withAuthResult('Get invitation route', handleGetInvitationRoute));
	router.post('/api/invitations/:token/accept', withAuthResult('Accept invitation route', handleAcceptInvitationRoute));

	// Everything in an organization is under its slug, `/api/orgs/:org/…`, which every route reads
	// as the organization the request is about (`requireViewer`), for a member of it. A sign-in's
	// callback is the one address a provider knows, outside it, and reads the organization from the
	// handshake it kept.
	const org = express.Router({mergeParams: true});
	router.use('/api/orgs/:org', org);
	org.get('/', withAuthResult('Get organization route', handleGetOrgRoute));
	org.post('/onboarded', withAuthResult('Finish onboarding route', handleFinishOnboardingRoute));
	org.patch('/', withAuthResult('Rename organization route', handleRenameOrgRoute));
	org.delete('/', withAuthResult('Delete organization route', handleDeleteOrgRoute));
	org.post('/leave', withAuthResult('Leave organization route', handleLeaveOrgRoute));
	org.get('/members', withAuthResult('List members route', handleListMembersRoute));
	org.delete('/members/:userId', withAuthResult('Remove member route', handleRemoveMemberRoute));
	org.post('/invitations', withAuthResult('Invite route', handleInviteRoute));
	org.delete('/invitations/:invitationId', withAuthResult('Revoke invitation route', handleRevokeInvitationRoute));

	org.get('/connections', withAuthResult('List connections route', handleListConnectionsRoute));
	// Each integration's own connect routes, as its module declares them: the starts and the forms
	// under the organization, the callbacks top-level navigations outside it.
	router.use('/api/connections', requireBrowserOrigin);
	for (const integration of apiIntegrations()) {
		mountConnectRoutes(router, org, integration);
	}
	org.get('/connections/:connectionId', withAuthResult('Get connection route', handleGetConnectionRoute));
	org.delete('/connections/:connectionId', withAuthResult('Delete connection route', handleDeleteConnectionRoute));
	org.put('/connections/:connectionId/defaults', withAuthResult('Set connection defaults route', handleSetConnectionDefaultsRoute));
	org.put('/connections/:connectionId/name', withAuthResult('Rename connection route', handleRenameConnectionRoute));
	org.post('/connections/:connectionId/share', withAuthResult('Share connection route', handleShareConnectionRoute));
	org.post('/connections/:connectionId/tools', withAuthResult('Refresh custom MCP server tools route', handleRefreshCustomMcpToolsRoute));
	const records = '/connections/:connectionId/collections/:collectionId/records';
	org.get(records, withAuthResult('List records route', handleListRecordsRoute));
	org.post(records, withAuthResult('Create record route', handleCreateRecordRoute));
	org.get(`${records}/:recordId`, withAuthResult('Get record route', handleGetRecordRoute));
	org.put(`${records}/:recordId`, withAuthResult('Update record route', handleUpdateRecordRoute));
	org.delete(`${records}/:recordId`, withAuthResult('Delete record route', handleDeleteRecordRoute));

	// A custom MCP server's logo, the icon of its site, for the person's pages and the agent's alike.
	router.get('/api/favicons/:host', wrapAsyncRoute('Favicon route', handleFaviconRoute));

	org.get('/agents', withAuthResult('List agents route', handleListAgentsRoute));
	org.post('/agents', withAuthResult('Create agent route', handleCreateAgentRoute));
	org.get('/agents/:agentId', withAuthResult('Get agent route', handleGetAgentRoute));
	org.delete('/agents/:agentId', withAuthResult('Delete agent route', handleDeleteAgentRoute));
	org.post('/agents/:agentId/password', withAuthResult('Reset agent password route', handleResetAgentPasswordRoute));
	org.put('/agents/:agentId/name', withAuthResult('Rename agent route', handleRenameAgentRoute));
	org.put('/agents/:agentId/revoked', withAuthResult('Set agent revoked route', handleSetAgentRevokedRoute));
	org.post('/agents/:agentId/share', withAuthResult('Share agent route', handleShareAgentRoute));
	org.put('/agents/:agentId/grants/:connectionId', withAuthResult('Set agent grants route', handleSetAgentGrantsRoute));
	org.get('/agents/:agentId/mcp-clients', withAuthResult('List MCP clients route', handleListMcpClientsRoute));
	org.delete('/agents/:agentId/mcp-clients/:grantId', withAuthResult('Disconnect MCP client route', handleDisconnectMcpClientRoute));

	org.get('/activity', withAuthResult('List activity route', handleListActivityRoute));
	org.get('/activity/timeline', withAuthResult('Activity timeline route', handleActivityTimelineRoute));
	org.get('/activity/tasks/:taskId', withAuthResult('Task run route', handleTaskRunRoute));

	// The home page: which widget fits what the person types, then its fields filled in.
	org.post('/intent', withAuthResult('Pick intent route', handlePickIntentRoute));
	org.post('/intent/fields', withAuthResult('Fill intent route', handleFillIntentRoute));
	// Its widgets: every connection with the collection a widget is about, read at once, and
	// written to as the person picks.
	org.get('/widgets/people', withAuthResult('Widget people route', handlePeopleRoute));
	org.get('/widgets/agenda', withAuthResult('Widget agenda route', handleAgendaRoute));
	org.get('/widgets/events', withAuthResult('Widget find events route', handleFindEventsRoute));
	org.post('/widgets/events', withAuthResult('Widget create event route', handleCreateEventRoute));
	org.put('/widgets/events', withAuthResult('Widget edit event route', handleEditEventRoute));
	org.get('/widgets/emails', withAuthResult('Widget find emails route', handleFindEmailsRoute));
	org.post('/widgets/emails', withAuthResult('Widget write email route', handleWriteEmailRoute));
	org.post('/widgets/emails/reply', withAuthResult('Widget reply email route', handleReplyEmailRoute));
	org.get('/widgets/mailboxes', withAuthResult('Widget mailboxes route', handleMailboxesRoute));
	org.get('/widgets/files', withAuthResult('Widget find files route', handleFindFilesRoute));
	org.get('/widgets/meetings', withAuthResult('Widget find meetings route', handleFindMeetingsRoute));
	org.get('/widgets/records', withAuthResult('Widget find records route', handleFindRecordsRoute));
	org.post('/widgets/answer', withAuthResult('Widget answer route', handleAnswerRoute));
	org.get('/widgets/rates', withAuthResult('Widget exchange rates route', handleRatesRoute));
	org.get('/widgets/accounts', withAuthResult('Widget bank accounts route', handleBankAccountsRoute));
	org.get('/widgets/transactions', withAuthResult('Widget bank transactions route', handleBankTransactionsRoute));

	// The Chat page: the organization's built-in agents and the member's conversations with them.
	// Nothing here runs the model: the worker in each api instance does (harness/worker.ts); a
	// message queues its work.
	const chat = chatRoutes(harnessStore);
	org.get('/chat/personas', withAuthResult('List personas route', chat.handleListPersonasRoute));
	org.post('/chat/personas', withAuthResult('Create persona route', chat.handleCreatePersonaRoute));
	org.put('/chat/personas/:personaId', withAuthResult('Update persona route', chat.handleUpdatePersonaRoute));
	org.delete('/chat/personas/:personaId', withAuthResult('Delete persona route', chat.handleDeletePersonaRoute));
	org.get('/chat/personas/:personaId/thread', withAuthResult('Get chat thread route', chat.handleGetThreadRoute));
	org.post('/chat/personas/:personaId/messages', withAuthResult('Post chat message route', chat.handlePostMessageRoute));

	// The agent side: its own sign-in and cookie, and every request made for one of the agent's
	// tasks, checked against the agent's access and logged with the task.
	router.post('/agent-auth/login', requireBrowserOrigin, wrapAsyncRoute('Agent login route', handleAgentLoginRoute));
	router.post('/agent-auth/logout', requireBrowserOrigin, wrapAsyncRoute('Agent logout route', handleAgentLogoutRoute));
	router.use('/api/agent', requireBrowserOrigin);
	router.get('/api/agent/me', withAgentAuthResult('Agent me route', handleAgentMeRoute));
	router.get('/api/agent/tasks', withAgentAuthResult('Agent list tasks route', handleAgentListTasksRoute));
	router.post('/api/agent/tasks', withAgentAuthResult('Agent start task route', handleAgentStartTaskRoute));
	router.get('/api/agent/tasks/:taskId', withAgentAuthResult('Agent get task route', handleAgentGetTaskRoute));
	router.post('/api/agent/tasks/:taskId/finish', withAgentAuthResult('Agent finish task route', handleAgentFinishTaskRoute));
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

/**
 * The routes connecting an integration, by how it is connected (`ConnectRoutes`): a sign-in's start
 * under `/api/orgs/:org/connections/<id>/start` and its callback at `/api/connections/<id>/callback`,
 * and its API key where it takes one; a form's connect and test; Plaid's exchange and Link token; a
 * custom MCP server's connect and callback.
 */
function mountConnectRoutes(router: express.Router, org: express.Router, {id, connect}: ApiIntegration): void {
	if (!connect) {
		return;
	}

	if (connect.kind === 'signIn') {
		const {handleStart, handleCallback, handleKey} = connect.routes();
		org.get(`/connections/${id}/start`, withAuth(`Start ${connect.name} sign-in route`, handleStart));
		router.get(`/api/connections/${id}/callback`, withAuth(`${connect.name} sign-in callback route`, handleCallback));
		if (handleKey) {
			org.post(`/connections/${id}`, withAuthResult(`Connect ${connect.name} with an API key route`, handleKey));
		}
		return;
	}

	if (connect.kind === 'form') {
		const {handleConnect, handleTest} = connect.routes();
		org.post(`/connections/${id}`, withAuthResult(`Connect ${connect.name} route`, handleConnect));
		org.post(`/connections/${id}/test`, withAuthResult(`Test ${connect.name} route`, handleTest));
		return;
	}

	if (connect.kind === 'bank') {
		const {handleConnect, handleLinkToken} = connect.routes();
		org.post(`/connections/${id}`, withAuthResult(`Connect ${connect.name} route`, handleConnect));
		org.post(`/connections/${id}/link-token`, withAuthResult(`Create ${connect.name} Link token route`, handleLinkToken));
		return;
	}

	const {handleConnect, handleCallback} = connect.routes();
	const name = `${connect.name.charAt(0).toUpperCase()}${connect.name.slice(1)}`;
	org.post(`/connections/${id}`, withAuth(`Connect ${connect.name} route`, handleConnect));
	router.get(`/api/connections/${id}/callback`, withAuth(`${name} sign-in callback route`, handleCallback));
}
