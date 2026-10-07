import {existsSync} from 'node:fs';
import {join} from 'node:path';

import express from 'express';

import {log} from '../observability/log';
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
		// Said once at boot, since every page would otherwise just be a 404.
		if (!existsSync(join(env.WEB_DIR, 'index.html'))) {
			log.warn('WEB_DIR has no index.html; build the web app into it, or unset WEB_DIR to serve the api alone', {webDir: env.WEB_DIR});
		}
		app.use(serveWeb(env.WEB_DIR));
	}

	app.use((_req, res) => {
		res.status(404).json({error: 'not_found'});
	});

	return app;
}
