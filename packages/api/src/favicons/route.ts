import type {IncomingHttpHeaders} from 'node:http';

import type {Request, Response} from 'express';
import {Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {authenticateAgentRequest} from '../agent-auth/session';
import {authenticateApiRequest} from '../utils/auth';
import {sendApiError} from '../server/response';
import {faviconOf, mainDomain} from './favicon';

const KEEP_SECONDS = 24 * 60 * 60;
const KEEP_MISS_SECONDS = 60 * 60;

// A signed-in person, or else a signed-in agent.
async function signedIn(headers: IncomingHttpHeaders): Promise<Result<void, ApiError>> {
	const person = await authenticateApiRequest(headers);
	if (person.isOk()) {
		return Ok(undefined);
	}
	return (await authenticateAgentRequest(headers)).map(() => undefined);
}

/**
 * `GET /api/favicons/:host`: the icon of the site a custom MCP server's host belongs to, for the
 * logo of its connection, to a signed-in person or agent. The icon is a stranger's file served
 * from this origin, so it is sent as one that can run nothing, an SVG's scripts included.
 */
export async function handleFaviconRoute(req: Request, res: Response): Promise<void> {
	const signed = await signedIn(req.headers);
	if (signed.isErr()) {
		sendApiError(res, signed.error);
		return;
	}

	const domain = mainDomain(req.params.host ?? '');
	const favicon = domain === null ? null : await faviconOf(domain);
	if (!favicon) {
		res.setHeader('Cache-Control', `private, max-age=${KEEP_MISS_SECONDS}`);
		sendApiError(res, ApiErr.notFound('favicon'));
		return;
	}

	res
		.status(200)
		.setHeader('Content-Type', favicon.type)
		.setHeader('Cache-Control', `private, max-age=${KEEP_SECONDS}`)
		.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
		.setHeader('X-Content-Type-Options', 'nosniff')
		.end(Buffer.from(favicon.bytes));
}
