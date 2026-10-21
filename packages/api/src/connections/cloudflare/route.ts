import type {BuiltInMcp} from '../mcp/built-in';
import {listMcpTools} from '../mcp/mcp-client';
import {CLOUDFLARE, getCloudflareAccount} from './cloudflare-mcp';

/**
 * Cloudflare, through its MCP server, as Linear is, signed in to or given an API token, user's or
 * account's, which its server takes as a bearer token. A new Cloudflare connection lets agents
 * read; creating and changing, and deleting, are turned on on the connection's page. A custom
 * connection's `execute` ran any code, so it was every action at once; its `search` and `docs`
 * reached nothing of the account, so their settings count for nothing.
 */
export const CLOUDFLARE_MCP: BuiltInMcp = {
	integrationId: 'cloudflare',
	server: CLOUDFLARE,
	account: getCloudflareAccount,
	// Cloudflare turns a bad token down at the door, so listing the tools with it is enough.
	apiKey: {check: async (key) => (await listMcpTools(CLOUDFLARE, key)).map(() => undefined)},
	defaults: ['read'],
	tools: {execute: {actions: ['read', 'write', 'delete']}},
};
