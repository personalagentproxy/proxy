import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import express from 'express';

import {log} from '../observability/log';
import {env} from '../utils/env';
import {createApiRouter} from './create-api-router';
import {serveWeb} from './serve-web';

// The web app's build sits at a fixed place beside this package, packages/web/dist, in the repo
// and in the image alike. In development there is none: Vite serves the app and proxies the api.
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

export function createHttpApp() {
	const app = express();

	// Behind a TLS-terminating proxy, trust X-Forwarded-* so `req.secure` and `req.hostname`
	// describe the original request.
	app.set('trust proxy', true);

	app.get('/health', (_req, res) => {
		res.json({ok: true});
	});

	app.use(createApiRouter());

	if (existsSync(join(webDist, 'index.html'))) {
		app.use(serveWeb(webDist));
	} else if (env.NODE_ENV === 'production') {
		// Said once at boot, since every page would otherwise just be a 404.
		log.warn('No web app build at packages/web/dist, so only the api is served. Build it with `bun run --cwd packages/web build`.');
	}

	app.use((_req, res) => {
		res.status(404).json({error: 'not_found'});
	});

	return app;
}
