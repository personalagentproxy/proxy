import type {NextFunction, Request, Response} from 'express';

import {getAllowedOrigin} from './allowed-origin';

const allowedOrigin = getAllowedOrigin();

// Requests that can't change state need no CSRF guard.
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for the cookie-authenticated routes. The `SameSite=Lax` session cookie still rides
 * along on cross-site top-level navigations, and nothing stops another site from sending a
 * request. So a state-changing request must carry the app's exact Origin, which browsers send
 * with every write, the web app's own included.
 */
export function requireBrowserOrigin(req: Request, res: Response, next: NextFunction): void {
	if (safeMethods.has(req.method)) {
		next();
		return;
	}

	// Without a configured app origin there is nothing to compare against; sign-in does not work
	// then either.
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
