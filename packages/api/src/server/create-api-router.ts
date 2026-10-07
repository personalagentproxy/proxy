import express from 'express';

import {handleListActivityRoute} from '../activity/route';
import {handleAgentLoginRoute, handleAgentLogoutRoute} from '../agent-auth/session';
import {
	handleAgentCreateRecordRoute,
	handleAgentDeleteRecordRoute,
	handleAgentGetRecordRoute,
	handleAgentListRecordsRoute,
	handleAgentListToolsRoute,
	handleAgentMeRoute,
	handleAgentRunCommandRoute,
	handleAgentRunNewCommandRoute,
	handleAgentRunToolRoute,
	handleAgentUpdateRecordRoute,
} from '../agent-side/route';
import {
	handleCreateAgentRoute,
	handleDeleteAgentRoute,
	handleGetAgentRoute,
	handleListAgentsRoute,
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
import {handleDeleteConnectionRoute, handleGetConnectionRoute, handleListConnectionsRoute, handleSetConnectionDefaultsRoute} from '../connections/route';
import {handleMeRoute} from '../me/route';
import {handleCreateRecordRoute, handleDeleteRecordRoute, handleGetRecordRoute, handleListRecordsRoute, handleUpdateRecordRoute} from '../records/route';
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
	const agentRecords = '/api/agent/connections/:connectionId/collections/:collectionId/records';
	router.get(agentRecords, withAgentAuthResult('Agent list records route', handleAgentListRecordsRoute));
	router.post(agentRecords, withAgentAuthResult('Agent create record route', handleAgentCreateRecordRoute));
	router.get(`${agentRecords}/:recordId`, withAgentAuthResult('Agent get record route', handleAgentGetRecordRoute));
	router.put(`${agentRecords}/:recordId`, withAgentAuthResult('Agent update record route', handleAgentUpdateRecordRoute));
	router.delete(`${agentRecords}/:recordId`, withAgentAuthResult('Agent delete record route', handleAgentDeleteRecordRoute));
	router.post(`${agentRecords}/:recordId/commands/:commandId`, withAgentAuthResult('Agent run command route', handleAgentRunCommandRoute));
	router.post('/api/agent/connections/:connectionId/collections/:collectionId/commands/:commandId', withAgentAuthResult('Agent run new command route', handleAgentRunNewCommandRoute));

	return router;
}
