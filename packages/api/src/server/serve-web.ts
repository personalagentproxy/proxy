import {join, resolve} from 'node:path';

import express from 'express';

// The api's own paths. Every other GET is a page of the web app, which routes in the browser.
const apiPrefixes = ['/api/', '/auth/', '/agent-auth/'];

/**
 * Serves the web app's build from `dir`, so one server is the whole of Proxy on one origin: the
 * files as they are, and `index.html` for every other path.
 */
export function serveWeb(dir: string): express.Router {
	const root = resolve(dir);
	const router = express.Router();

	// Vite names assets by their content, so a name never changes what it serves. A missing one is
	// a 404, not the app's page.
	router.use('/assets', express.static(join(root, 'assets'), {immutable: true, maxAge: '1y', fallthrough: false}));
	router.use(express.static(root, {index: false}));

	router.get('*', (req, res, next) => {
		if (apiPrefixes.some((prefix) => req.path.startsWith(prefix))) {
			next();
			return;
		}

		// Always revalidated, so a new release reaches the browser on its next load.
		res.setHeader('Cache-Control', 'no-cache');
		res.sendFile(join(root, 'index.html'));
	});

	return router;
}
