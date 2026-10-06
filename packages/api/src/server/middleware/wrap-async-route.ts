import type {Request, Response} from 'express';

import {log, serializeError} from '../../observability/log';

/**
 * Wraps an async Express route handler so unhandled rejections become a 500 JSON response.
 */
export function wrapAsyncRoute(routeLabel: string, handler: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response) => void {
	return (req, res) => {
		void handler(req, res).catch((error: unknown) => {
			log.error('route handler threw', {routeLabel, ...serializeError(error)});
			if (res.headersSent) {
				return;
			}

			res.status(500).json({error: 'internal_error'});
		});
	};
}
