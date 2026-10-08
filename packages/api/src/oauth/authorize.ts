import type {Request, Response} from 'express';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getAgent} from '@proxy/db/agent';
import {createOAuthCode, getOAuthClient, type OAuthClientRow} from '@proxy/db/oauth';
import {suggestAgentProvider} from '@proxy/integrations';

import {createAgentLogin} from '../agents/create-agent-login';
import {queryParam} from '../auth/session';
import {log, serializeError} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {decryptSecret, encryptSecret} from '../utils/secret-crypto';
import {requireUserOrgId} from '../utils/user-org';
import {CODE_TTL_MS, hashToken, mcpResourceUrl, randomToken, requireAppUrl, withParams} from './oauth-config';

/**
 * Signing an MCP client in as one of a person's agents. The client sends the browser to
 * `/oauth/authorize`; once the client and its redirect check out, the request is sealed, encrypted
 * with `ENCRYPTION_KEY`, into the address of the web app's consent page, which has the person sign
 * in and choose the agent login the client works as, or make one. Allowing it sends the browser
 * back to the client with a code; denying it, with `access_denied`.
 */

// Long enough to sign in first.
const REQUEST_TTL_MS = 30 * 60 * 1000;

const sealedRequestSchema = z.object({
	clientId: z.string(),
	redirectUri: z.string(),
	state: z.string().nullable(),
	codeChallenge: z.string(),
	expiresAt: z.number(),
});

type AuthorizationRequest = z.infer<typeof sealedRequestSchema>;

// The client's own mistakes before its redirect can be trusted are shown in the browser, never
// sent to the redirect: an unknown client, or a redirect it didn't register.
function refuse(res: Response, message: string): void {
	res.status(400).type('text/plain').send(`${message}. Start connecting again from the app you came from.`);
}

// A registered client may leave its redirect out when it has only one.
function chooseRedirect(client: OAuthClientRow, given: string | null): string | null {
	if (given === null) {
		return client.redirectUris.length === 1 ? (client.redirectUris[0] ?? null) : null;
	}
	return client.redirectUris.includes(given) ? given : null;
}

// What an MCP client may name as the resource: the MCP server, or Personal Agent Proxy itself.
function isOurResource(appUrl: string, resource: string): boolean {
	return [mcpResourceUrl(appUrl), appUrl, `${appUrl}/`].includes(resource);
}

/** `GET /oauth/authorize` */
export async function handleAuthorizeRoute(req: Request, res: Response): Promise<void> {
	const appUrl = requireAppUrl();
	if (appUrl.isErr()) {
		refuse(res, 'Personal Agent Proxy is missing its APP_URL');
		return;
	}
	const clientId = queryParam(req, 'client_id');
	const client = clientId ? await getOAuthClient(clientId) : Ok(null);
	if (client.isErr()) {
		log.error('Reading an OAuth client failed', serializeError(client.error));
		res.status(500).type('text/plain').send('Something went wrong. Try again in a moment.');
		return;
	}
	if (!client.value) {
		refuse(res, 'This app is not registered with Personal Agent Proxy');
		return;
	}
	const redirectUri = chooseRedirect(client.value, queryParam(req, 'redirect_uri'));
	if (!redirectUri) {
		refuse(res, 'This app asked to come back to an address it did not register');
		return;
	}

	const state = queryParam(req, 'state');
	const back = (error: string, description: string) => res.redirect(withParams(redirectUri, {error, error_description: description, state, iss: appUrl.value}));
	if (queryParam(req, 'response_type') !== 'code') {
		back('unsupported_response_type', 'Only the code response type is supported');
		return;
	}
	const codeChallenge = queryParam(req, 'code_challenge');
	if (!codeChallenge || queryParam(req, 'code_challenge_method') !== 'S256') {
		back('invalid_request', 'PKCE with S256 is required');
		return;
	}
	const resource = queryParam(req, 'resource');
	if (resource !== null && !isOurResource(appUrl.value, resource)) {
		back('invalid_target', `Personal Agent Proxy only gives tokens for ${mcpResourceUrl(appUrl.value)}`);
		return;
	}

	const sealed = encryptSecret(JSON.stringify({clientId: client.value.id, redirectUri, state, codeChallenge, expiresAt: Date.now() + REQUEST_TTL_MS} satisfies AuthorizationRequest));
	if (sealed.isErr()) {
		log.error('Sealing an OAuth request failed', serializeError(sealed.error));
		res.status(500).type('text/plain').send('Something went wrong. Try again in a moment.');
		return;
	}
	res.redirect(`${appUrl.value}/connect-agent?${new URLSearchParams({request: sealed.value})}`);
}

function unseal(sealed: string): Result<AuthorizationRequest, ApiError> {
	const unreadable = ApiErr.validationError('This sign-in request is not readable');
	const request = decryptSecret(sealed)
		.mapErr(() => unreadable)
		.andThen((json) => Result.wrap((): unknown => JSON.parse(json)).mapErr(() => unreadable))
		.andThen((parsed) => parseSchema(sealedRequestSchema, parsed));
	if (request.isOk() && request.value.expiresAt <= Date.now()) {
		return Err(ApiErr.validationError('This sign-in request has expired. Start connecting again from the app you came from.'));
	}
	return request;
}

function loadRequest(sealed: unknown): Promise<Result<{request: AuthorizationRequest; client: OAuthClientRow}, ApiError>> {
	return Do(async ($) => {
		const request = $(unseal($(parseSchema(z.string().min(1), sealed))));
		const client = $(requirePresent($(await getOAuthClient(request.clientId)), ApiErr.notFound('client', request.clientId)));
		return {request, client};
	});
}

export type AuthorizationRequestResponse = {
	clientName: string;
	// Where the browser goes back to, so the person can tell which app is asking.
	redirectHost: string;
	// The agent the client's name points at, such as Claude, if it has one.
	suggestedProviderId: string | null;
};

/** `GET /api/oauth/request?request=…`: who is asking, for the consent page. */
export function handleGetAuthorizationRequestRoute(request: AuthenticatedRequest): Promise<Result<AuthorizationRequestResponse, ApiError>> {
	return Do(async ($) => {
		$(await requireUserOrgId(request));
		const {request: authorization, client} = $(await loadRequest(request.query.request));
		const redirect = new URL(authorization.redirectUri);
		return {clientName: client.name, redirectHost: redirect.host || redirect.protocol, suggestedProviderId: suggestAgentProvider(client.name)?.id ?? null};
	});
}

const consentBodySchema = z.union([
	z.object({request: z.string(), allow: z.literal(false)}),
	z.object({request: z.string(), allow: z.literal(true), agentId: z.string().min(1)}),
	z.object({request: z.string(), allow: z.literal(true), providerId: z.string().min(1)}),
]);

// The agent login the client works as: one of the organization's, not revoked, or a new one.
function chooseAgent(orgId: string, body: z.infer<typeof consentBodySchema>): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if ('agentId' in body) {
			const agent = $(requirePresent($(await getAgent(orgId, body.agentId)), ApiErr.notFound('agent', body.agentId)));
			if (agent.revokedAt !== null) {
				return $(Err(ApiErr.validationError(`${agent.name} is revoked. Restore it first, or choose another agent.`)));
			}
			return agent.id;
		}
		if ('providerId' in body) {
			return $(await createAgentLogin(orgId, body.providerId)).agent.id;
		}
		return $(Err(ApiErr.validationError('Choose an agent')));
	});
}

/**
 * `POST /api/oauth/consent`: the person's answer. Allowing it as an agent makes a code for the
 * client, good once for a few minutes; either way the answer is where the browser goes next.
 */
export function handleConsentRoute(request: AuthenticatedRequest): Promise<Result<{redirectTo: string}, ApiError>> {
	return Do(async ($) => {
		const appUrl = $(requireAppUrl());
		const body = $(parseSchema(consentBodySchema, request.body));
		const {request: authorization, client} = $(await loadRequest(body.request));
		const {redirectUri, state} = authorization;
		if (!body.allow) {
			return {redirectTo: withParams(redirectUri, {error: 'access_denied', error_description: 'The person declined', state, iss: appUrl})};
		}

		const orgId = $(await requireUserOrgId(request));
		const agentId = $(await chooseAgent(orgId, body));
		const code = randomToken();
		$(await createOAuthCode({codeHash: hashToken(code), clientId: client.id, agentId, redirectUri, codeChallenge: authorization.codeChallenge, expires: new Date(Date.now() + CODE_TTL_MS)}));
		return {redirectTo: withParams(redirectUri, {code, state, iss: appUrl})};
	});
}
