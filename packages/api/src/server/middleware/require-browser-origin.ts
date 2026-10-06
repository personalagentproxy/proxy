import type {NextFunction, Request, Response} from 'express';

import {getAllowedOrigin} from './allowed-origin';

const allowedOrigin = getAllowedOrigin();

// Requests that can't change state need no CSRF guard: GET and HEAD are safe, and OPTIONS is the
// CORS preflight, which has to succeed for the browser to send the real request.
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for the cookie-authenticated routes. The `SameSite=Lax` session cookie still rides
 * along on cross-site top-level navigations, and CORS only stops another site from reading a
 * response, not from sending the request. So a state-changing request must carry the app's
 * exact Origin; browsers always send one on cross-origin fetches and form posts.
 */
export function requireBrowserOrigin(req: Request, res: Response, next: NextFunction): void {
	if (safeMethods.has(req.method)) {
		next();
		return;
	}

	// Without a configured app origin there is nothing to enforce, but then the credentialed CORS
	// middleware can't let a cross-origin browser send cookies either.
	if (!allowedOrigin) {
		next();
		return;
	}

	if (req.headers.origin === allowedOrigin) {
		next();
		return;
	}

	res.status(403).json({error: 'forbidden_origin'});
}
