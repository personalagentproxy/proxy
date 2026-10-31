import {textParam, type BuiltInMcp} from '../mcp/built-in';
import {listMcpTools} from '../mcp/mcp-client';
import {KEENABLE} from './keenable-mcp';

/**
 * Keenable, through its MCP server, as Exa and Parallel are, signed in to or given an API key; its
 * keyless server is the same service. Keenable says nothing of who signed in, so the person names
 * each connection, and an organization can have as many as it likes. A new Keenable connection lets
 * agents search the web and read pages.
 */
export const KEENABLE_MCP: BuiltInMcp = {
	integrationId: 'keenable',
	server: KEENABLE,
	// Keenable turns a bad key down at the door, so listing the tools with it is enough.
	apiKey: {check: async (key) => (await listMcpTools(KEENABLE, key)).map(() => undefined)},
	defaults: ['search', 'fetch'],
	tools: {
		search_web_pages: {actions: ['search'], run: (params) => ({collectionId: 'searches', operation: 'run', title: textParam(params, 'query')})},
		fetch_page_content: {actions: ['fetch'], run: (params) => ({collectionId: 'pages', operation: 'read', title: textParam(params, 'url')})},
	},
};
