import {randomUUID} from 'node:crypto';

import type {NextFunction, Request, Response} from 'express';

import {BLOBS_PATH} from '@proxy/contracts/blobs';

import {log} from '../../observability/log';
import {runInContext} from '../../observability/request-context';

/**
 * Opens the log scope of every request, with an id the response carries back in `x-request-id`,
 * so a person can quote it, and writes one line when the request is answered: its status, how
 * long it took, and the route that matched, which the dashboards count and time requests by. A
 * blob's URL is written as its route, never with its token, which moves the blob's bytes.
 */

const REQUEST_ID_HEADER = 'x-request-id';

// What matched, with the parameters as names: `/api/orgs/:org/connections`, not one slug per line.
function matchedRoute(req: Request): string | undefined {
	if (!req.route) {
		return undefined;
	}
	const path = typeof req.route.path === 'string' ? req.route.path : String(req.route.path);
	return `${req.baseUrl}${path}`;
}

// The path as every line of the request says it: a blob's without its token.
function loggedPath(path: string): string {
	if (path.startsWith(`${BLOBS_PATH}/`)) {
		return `${BLOBS_PATH}/:token`;
	}
	return path;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
	const incoming = req.get(REQUEST_ID_HEADER);
	const requestId = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
	res.setHeader(REQUEST_ID_HEADER, requestId);

	const start = performance.now();

	runInContext({requestId, method: req.method, path: loggedPath(req.path)}, () => {
		let logged = false;
		const finish = (aborted: boolean): void => {
			if (logged) {
				return;
			}
			logged = true;
			log.info('request finished', {
				status: res.statusCode,
				durationMs: Math.round(performance.now() - start),
				aborted,
				route: matchedRoute(req),
			});
		};

		res.on('finish', () => finish(false));
		res.on('close', () => {
			if (!res.writableFinished) {
				finish(true);
			}
		});

		next();
	});
}
