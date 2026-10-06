import type {Request, RequestHandler} from 'express';
import type {Result} from 'ts-results-es';

import type {SignedInAgent} from '@proxy/db/agent';
import type {ApiError} from '@proxy/utils';

import {authenticateAgentRequest} from '../../agent-auth/session';
import {log, serializeError} from '../../observability/log';
import {sendApiError, sendResult} from '../response';

/** A request that has passed through `withAgentAuthResult`: `agent` is the signed-in agent. */
export type AgentRequest = Request & {agent: SignedInAgent};

/** Like `withAuthResult` for the agent side: 401 without a live agent session. */
export function withAgentAuthResult<T>(routeLabel: string, handler: (req: AgentRequest) => Promise<Result<T, ApiError>>): RequestHandler {
	return (req, res) => {
		void (async () => {
			const result = await authenticateAgentRequest(req.headers);
			if (result.isErr()) {
				sendApiError(res, result.error);
				return;
			}
			const authed = req as AgentRequest;
			authed.agent = result.value;
			sendResult(res, await handler(authed));
		})().catch((error: unknown) => {
			log.error('route handler threw', {routeLabel, ...serializeError(error)});
			if (res.headersSent) {
				return;
			}
			res.status(500).json({error: 'internal_error'});
		});
	};
}
