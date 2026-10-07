import type {Request, Response} from 'express';

import {mcpResourceUrl, OAUTH_SCOPE, requireAppUrl} from './oauth-config';

// What an MCP client reads to sign in, starting from the MCP server's 401: the resource's
// metadata (RFC 9728) points at the authorization server, whose metadata (RFC 8414) lists its
// endpoints. Both are public.

function sendMetadata(res: Response, build: (appUrl: string) => Record<string, unknown>): void {
	const appUrl = requireAppUrl();
	if (appUrl.isErr()) {
		res.status(500).json({error: 'server_error', error_description: 'APP_URL is not set'});
		return;
	}
	res.setHeader('Cache-Control', 'public, max-age=3600');
	res.json(build(appUrl.value));
}

/** `GET /.well-known/oauth-protected-resource`, and the same under `/mcp`. */
export function handleProtectedResourceMetadataRoute(_req: Request, res: Response): void {
	sendMetadata(res, (appUrl) => ({
		resource: mcpResourceUrl(appUrl),
		authorization_servers: [appUrl],
		bearer_methods_supported: ['header'],
		scopes_supported: [OAUTH_SCOPE],
		resource_name: 'Personal Agent Proxy',
	}));
}

/** `GET /.well-known/oauth-authorization-server` */
export function handleAuthorizationServerMetadataRoute(_req: Request, res: Response): void {
	sendMetadata(res, (appUrl) => ({
		issuer: appUrl,
		authorization_endpoint: `${appUrl}/oauth/authorize`,
		token_endpoint: `${appUrl}/oauth/token`,
		registration_endpoint: `${appUrl}/oauth/register`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
		scopes_supported: [OAUTH_SCOPE],
		authorization_response_iss_parameter_supported: true,
	}));
}
