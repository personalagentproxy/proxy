import express from 'express';

import {handleDevLoginRoute} from '../auth/dev-login';
import {handleEmailSignInRoute, handleEmailVerifyRoute} from '../auth/email';
import {handleGoogleCallbackRoute, handleGoogleStartRoute} from '../auth/google';
import {handleSignOutRoute} from '../auth/signout';
import {handleConnectEmailRoute} from '../connections/email/route';
import {handleDeleteConnectionRoute, handleGetConnectionRoute, handleListConnectionsRoute, handleSetConnectionDefaultRoute} from '../connections/route';
import {handleMeRoute} from '../me/route';
import {handleCreateRecordRoute, handleDeleteRecordRoute, handleGetRecordRoute, handleListRecordsRoute, handleUpdateRecordRoute} from '../records/route';
import {apiCorsMiddleware} from './middleware/api-cors';
import {requireBrowserOrigin} from './middleware/require-browser-origin';
import {withAuthResult} from './middleware/require-auth';
import {wrapAsyncRoute} from './middleware/wrap-async-route';

function handle204(_req: express.Request, res: express.Response): void {
	res.status(204).end();
}

export function createApiRouter(): express.Router {
	const router = express.Router();

	router.use(express.json({limit: '1mb'}));

	// Sign-in and sign-out. No auth middleware: these mint or revoke the session cookie, and
	// sign-out must succeed without a valid session. The OAuth endpoints and the magic-link verify
	// are top-level navigations (302 redirects, CORS does not apply); the magic-link send,
	// sign-out and dev login are fetches from the app origin, so they take CORS plus the
	// `requireBrowserOrigin` CSRF guard.
	router.get('/auth/google', wrapAsyncRoute('Google OAuth start route', handleGoogleStartRoute));
	router.get('/auth/google/callback', wrapAsyncRoute('Google OAuth callback route', handleGoogleCallbackRoute));
	router.options('/auth/email', apiCorsMiddleware, handle204);
	router.post('/auth/email', apiCorsMiddleware, requireBrowserOrigin, wrapAsyncRoute('Email sign-in route', handleEmailSignInRoute));
	router.get('/auth/email/verify', wrapAsyncRoute('Email verify route', handleEmailVerifyRoute));
	router.options('/auth/signout', apiCorsMiddleware, handle204);
	router.post('/auth/signout', apiCorsMiddleware, requireBrowserOrigin, wrapAsyncRoute('Sign-out route', handleSignOutRoute));
	router.options('/auth/dev/login', apiCorsMiddleware, handle204);
	router.post('/auth/dev/login', apiCorsMiddleware, requireBrowserOrigin, wrapAsyncRoute('Dev login route', handleDevLoginRoute));

	router.use('/api/me', apiCorsMiddleware, requireBrowserOrigin);
	router.options('/api/me', handle204);
	router.get('/api/me', withAuthResult('Me route', handleMeRoute));

	router.use('/api/connections', apiCorsMiddleware, requireBrowserOrigin);
	router.options('/api/connections*', handle204);
	router.get('/api/connections', withAuthResult('List connections route', handleListConnectionsRoute));
	router.post('/api/connections/email', withAuthResult('Connect email route', handleConnectEmailRoute));
	router.get('/api/connections/:connectionId', withAuthResult('Get connection route', handleGetConnectionRoute));
	router.delete('/api/connections/:connectionId', withAuthResult('Delete connection route', handleDeleteConnectionRoute));
	router.put('/api/connections/:connectionId/defaults/:collectionId', withAuthResult('Set connection default route', handleSetConnectionDefaultRoute));
	const records = '/api/connections/:connectionId/collections/:collectionId/records';
	router.get(records, withAuthResult('List records route', handleListRecordsRoute));
	router.post(records, withAuthResult('Create record route', handleCreateRecordRoute));
	router.get(`${records}/:recordId`, withAuthResult('Get record route', handleGetRecordRoute));
	router.put(`${records}/:recordId`, withAuthResult('Update record route', handleUpdateRecordRoute));
	router.delete(`${records}/:recordId`, withAuthResult('Delete record route', handleDeleteRecordRoute));

	router.use((_req, res) => {
		res.status(404).json({error: 'not_found'});
	});

	return router;
}
