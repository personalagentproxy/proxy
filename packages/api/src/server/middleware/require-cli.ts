import type {Request, RequestHandler, Response} from 'express';

import {authenticateCliRequest, type CliCaller} from '../../cli/authenticate';
import {log, serializeError} from '../../observability/log';
import {addContext} from '../../observability/request-context';
import {sendApiError} from '../response';

/** A request that has passed through `withCliAuth`: `cli` is who calls from the sandbox. */
export type CliRequest = Request & {cli: CliCaller};

/**
 * Like `withAgentAuthResult` for code in a sandbox (`/api/cli`): 401 without a token that is still
 * good for its agent, task and sandbox (cli/authenticate.ts). The handler writes its own answer,
 * since a call that failed is not the request failing.
 */
export function withCliAuth(routeLabel: string, handler: (req: CliRequest, res: Response) => Promise<void>): RequestHandler {
	return (req, res) => {
		void (async () => {
			const result = await authenticateCliRequest(req.headers);
			if (result.isErr()) {
				sendApiError(res, result.error);
				return;
			}
			const authed = req as CliRequest;
			authed.cli = result.value;
			addContext({agentId: result.value.agent.agentId, orgId: result.value.agent.orgId});
			await handler(authed, res);
		})().catch((error: unknown) => {
			log.error('route handler threw', {routeLabel, ...serializeError(error)});
			if (res.headersSent) {
				return;
			}
			res.status(500).json({error: 'internal_error'});
		});
	};
}
