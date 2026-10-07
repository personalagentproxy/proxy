import {randomBytes} from 'node:crypto';

import type {Request, Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {Do} from '@proxy/utils';
import {createOAuthClient} from '@proxy/db/oauth';

import {log, serializeError} from '../observability/log';
import {hashToken, isAllowedRedirectUri, randomToken} from './oauth-config';
import {sendOAuthError, type OAuthError} from './oauth-error';

/**
 * Dynamic Client Registration (RFC 7591): an MCP client such as Claude or ChatGPT registers itself
 * before its first sign-in. Registering gives it nothing: a person still signs in and chooses
 * which of their agents it works as.
 */

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

const registrationSchema = z.object({
	redirect_uris: z.array(z.string()).min(1).max(10),
	client_name: z.string().trim().min(1).max(100).optional(),
	token_endpoint_auth_method: z.enum(AUTH_METHODS).optional(),
	grant_types: z.array(z.string()).optional(),
	response_types: z.array(z.string()).optional(),
});

const GRANT_TYPES = ['authorization_code', 'refresh_token'];

type Registered = {
	client_id: string;
	client_id_issued_at: number;
	client_name: string;
	redirect_uris: string[];
	grant_types: string[];
	response_types: string[];
	token_endpoint_auth_method: (typeof AUTH_METHODS)[number];
	client_secret?: string;
	client_secret_expires_at?: number;
};

function invalid(description: string): OAuthError {
	return {status: 400, error: 'invalid_client_metadata', description};
}

function register(body: unknown): Promise<Result<Registered, OAuthError>> {
	return Do(async ($) => {
		const parsed = registrationSchema.safeParse(body);
		if (!parsed.success) {
			return $(Err(invalid(parsed.error.issues[0]?.message ?? 'Unreadable registration')));
		}
		const metadata = parsed.data;
		const badUri = metadata.redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
		if (badUri !== undefined) {
			return $(Err({status: 400, error: 'invalid_redirect_uri', description: `${badUri} can't be a redirect URI: use HTTPS, or HTTP on a loopback address`}));
		}
		const grantTypes = metadata.grant_types ?? GRANT_TYPES;
		if (grantTypes.some((grant) => !GRANT_TYPES.includes(grant))) {
			return $(Err(invalid('Only authorization_code and refresh_token are supported')));
		}
		if ((metadata.response_types ?? ['code']).some((type) => type !== 'code')) {
			return $(Err(invalid('Only the code response type is supported')));
		}

		const method = metadata.token_endpoint_auth_method ?? 'none';
		const secret = method === 'none' ? null : randomToken();
		const id = randomBytes(16).toString('base64url');
		const name = metadata.client_name ?? 'MCP client';
		const created = await createOAuthClient({id, name, redirectUris: metadata.redirect_uris, secretHash: secret && hashToken(secret)});
		if (created.isErr()) {
			log.error('Registering an OAuth client failed', serializeError(created.error));
			return $(Err({status: 500, error: 'server_error', description: 'The client could not be registered'}));
		}

		return {
			client_id: id,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			client_name: name,
			redirect_uris: metadata.redirect_uris,
			grant_types: grantTypes,
			response_types: ['code'],
			token_endpoint_auth_method: method,
			...(secret ? {client_secret: secret, client_secret_expires_at: 0} : {}),
		};
	});
}

/** `POST /oauth/register` */
export async function handleRegisterClientRoute(req: Request, res: Response): Promise<void> {
	const result = await register(req.body);
	if (result.isErr()) {
		sendOAuthError(res, result.error);
		return;
	}
	res.status(201).setHeader('Cache-Control', 'no-store').json(result.value);
}
