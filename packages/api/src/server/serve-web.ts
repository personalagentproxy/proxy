import {join, resolve} from 'node:path';

import express from 'express';

// The api's own paths, and everything under them. Every other GET is a page of the web app,
// which routes in the browser.
const apiPaths = ['/api', '/auth', '/agent-auth'];

function isApiPath(path: string): boolean {
	return apiPaths.some((apiPath) => path === apiPath || path.startsWith(`${apiPath}/`));
}

// On everything the web app is served with: no guessing a file's type from its contents, no full
// URLs sent to other sites, and no framing by them.
function setSecurityHeaders(res: express.Response): void {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

/**
 * Serves the web app's build from `dir`, so one server is the whole of Proxy on one origin: the
 * files as they are, and `index.html` for every other path.
 */
export function serveWeb(dir: string): express.Router {
	const root = resolve(dir);
	const router = express.Router();

	// Vite names assets by their content, so a name never changes what it serves. A missing one is
	// a 404, not the app's page.
	router.use('/assets', express.static(join(root, 'assets'), {immutable: true, maxAge: '1y', fallthrough: false, setHeaders: setSecurityHeaders}));
	router.use(express.static(root, {index: false, setHeaders: setSecurityHeaders}));

	router.get('*', (req, res, next) => {
		if (isApiPath(req.path)) {
			next();
			return;
		}

		setSecurityHeaders(res);
		// Always revalidated, so a new release reaches the browser on its next load.
		res.setHeader('Cache-Control', 'no-cache');
		// Without a callback, Express passes a failure to the error handler itself, leaving out
		// aborted connections.
		res.sendFile(join(root, 'index.html'));
	});

	return router;
}
