import {firstParam, textParam, type BuiltInMcp} from '../mcp/built-in';
import {callMcpTool} from '../mcp/mcp-client';
import {YOUCOM} from './youcom-mcp';

/**
 * You.com, through its MCP server, as Exa and Parallel are, signed in to or given an API key.
 * You.com says nothing of who signed in, so the person names each connection, and an organization
 * can have as many as it likes. A new You.com connection lets agents search the web and read pages.
 */
export const YOUCOM_MCP: BuiltInMcp = {
	integrationId: 'youcom',
	server: YOUCOM,
	// You.com lists its tools for anyone, so a key is checked by asking for the key's balance, which
	// costs nothing; a key You.com turns down fails the check.
	apiKey: {check: async (key) => (await callMcpTool(YOUCOM, key, 'you-balance', {})).map(() => undefined)},
	// Its keyless free profile asks for nothing and has no page reads, so it stays a custom server.
	staysCustom: (url) => url.searchParams.get('profile') === 'free',
	defaults: ['search', 'fetch'],
	tools: {
		'you-search': {actions: ['search'], run: (params) => ({collectionId: 'searches', operation: 'run', title: textParam(params, 'query')})},
		'you-contents': {actions: ['fetch'], run: (params) => ({collectionId: 'pages', operation: 'read', title: firstParam(params, 'urls')})},
	},
};
