import express from 'express';

import {createApiRouter} from './create-api-router';

export function createHttpApp() {
	const app = express();

	// Behind a TLS-terminating proxy, trust X-Forwarded-* so `req.secure` and `req.hostname`
	// describe the original request.
	app.set('trust proxy', true);

	app.get('/health', (_req, res) => {
		res.json({ok: true});
	});

	app.use(createApiRouter());

	return app;
}
