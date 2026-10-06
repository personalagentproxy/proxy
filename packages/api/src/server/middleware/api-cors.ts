import type {NextFunction, Request, Response} from 'express';

import {getAllowedOrigin} from './allowed-origin';

const allowedOrigin = getAllowedOrigin();

/**
 * Sets CORS headers for the web app's credentialed fetches when the request Origin matches
 * APP_URL.
 */
export function apiCorsMiddleware(req: Request, res: Response, next: NextFunction): void {
	const origin = req.headers.origin;

	// The allow-origin header depends on the request's Origin, so a cached response must not be
	// replayed for another origin. Set on both branches.
	res.vary('Origin');

	if (!origin || !allowedOrigin || origin !== allowedOrigin) {
		next();
		return;
	}

	res.setHeader('Access-Control-Allow-Origin', origin);
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
	next();
}
