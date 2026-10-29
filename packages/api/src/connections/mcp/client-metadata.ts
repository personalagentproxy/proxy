import type {Request, Response} from 'express';

import {sendMetadata} from '../../oauth/metadata';
import {builtInMcps} from '../built-in-mcp';
import {signInCallbackUrl} from '../connect-flow';
import {clientMetadataUrl} from './mcp-oauth';

/**
 * Personal Agent Proxy as an MCP client, described for an authorization server that takes a client
 * ID metadata document (draft-ietf-oauth-client-id-metadata-document) rather than a client
 * registered for each sign-in: its address is the `client_id`, so the document names itself as
 * one, and lists where every MCP sign-in comes back to, a custom server's and each built-in
 * integration's, since the authorization server holds a sign-in to those exactly. A public client:
 * no secret, PKCE, and refresh tokens.
 */

/** The document, for Personal Agent Proxy at `appUrl`. */
export function clientMetadata(appUrl: string) {
	return {
		client_id: clientMetadataUrl(appUrl),
		client_name: 'Personal Agent Proxy',
		client_uri: appUrl,
		logo_uri: `${appUrl}/favicon.svg`,
		redirect_uris: ['mcp' as const, ...builtInMcps().map((builtIn) => builtIn.integrationId)].map((integrationId) => signInCallbackUrl(appUrl, integrationId)),
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
	};
}

/** `GET /oauth/client-metadata.json` */
export function handleClientMetadataRoute(_req: Request, res: Response): void {
	sendMetadata(res, clientMetadata);
}
