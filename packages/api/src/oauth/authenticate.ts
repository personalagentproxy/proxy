import type {IncomingHttpHeaders} from 'node:http';

import {type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {SignedInAgent} from '@proxy/db/agent';
import {getAgentByAccessToken} from '@proxy/db/oauth';

import {hashToken, resourceMetadataUrl} from './oauth-config';

function bearerToken(headers: IncomingHttpHeaders): string | null {
	const header = headers.authorization;
	if (!header?.startsWith('Bearer ')) {
		return null;
	}
	return header.slice('Bearer '.length).trim() || null;
}

/** The agent an MCP request's access token signs in, or unauthenticated. */
export function authenticateBearer(headers: IncomingHttpHeaders): Promise<Result<SignedInAgent, ApiError>> {
	return Do(async ($) => {
		const token = $(requirePresent(bearerToken(headers), ApiErr.unauthenticated()));
		const agent = $(await getAgentByAccessToken(hashToken(token)));
		return $(requirePresent(agent, ApiErr.unauthenticated()));
	});
}

/**
 * The 401's `WWW-Authenticate`, pointing a client at where to sign in (RFC 9728). A token it sent
 * that doesn't work is `invalid_token`, so the client refreshes it or signs in again.
 */
export function wwwAuthenticate(appUrl: string, headers: IncomingHttpHeaders): string {
	const challenge = `Bearer resource_metadata="${resourceMetadataUrl(appUrl)}"`;
	if (bearerToken(headers) === null) {
		return challenge;
	}
	return `${challenge}, error="invalid_token"`;
}
