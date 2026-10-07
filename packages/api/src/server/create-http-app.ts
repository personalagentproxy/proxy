import express from 'express';

import {env} from '../utils/env';
import {createApiRouter} from './create-api-router';
import {serveWeb} from './serve-web';

export function createHttpApp() {
	const app = express();

	// Behind a TLS-terminating proxy, trust X-Forwarded-* so `req.secure` and `req.hostname`
	// describe the original request.
	app.set('trust proxy', true);

	app.get('/health', (_req, res) => {
		res.json({ok: true});
	});

	app.use(createApiRouter());

	if (env.WEB_DIR) {
		app.use(serveWeb(env.WEB_DIR));
	}

	app.use((_req, res) => {
		res.status(404).json({error: 'not_found'});
	});

	return app;
}
