import type {NextFunction, Request, Response} from 'express';

import {useSecureCookies} from '../auth/session';

// A year, what scanners expect.
const hstsMaxAgeSeconds = 365 * 24 * 60 * 60;

/**
 * On every response, the api's and the web app's alike: no guessing a file's type from its
 * contents, no full URLs sent to other sites, and no framing by any site, the web app's own pages
 * included. Served over HTTPS, browsers are also told to use nothing else from then on; whatever
 * terminates TLS in front, Render or Caddy, adds no such header itself.
 */
export function setSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
	if (useSecureCookies()) {
		res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAgeSeconds}`);
	}
	next();
}
