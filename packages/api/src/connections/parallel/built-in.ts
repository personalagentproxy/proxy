import {firstParam, textParam, type BuiltInMcp} from '../mcp/built-in';
import {listMcpTools} from '../mcp/mcp-client';
import {PARALLEL} from './parallel-mcp';

/**
 * Parallel, through its MCP server, as Exa is, signed in to or given an API key; its keyless server
 * is the same service, and so was its old one, whose tools have gone. Parallel says nothing of who signed in, so the person names each connection,
 * and an organization can have as many as it likes. A new Parallel connection lets agents search
 * the web and read pages.
 */
export const PARALLEL_MCP: BuiltInMcp = {
	integrationId: 'parallel',
	server: PARALLEL,
	otherHosts: ['search-mcp.parallel.ai'],
	// Parallel turns a bad key down at the door, so listing the tools with it is enough.
	apiKey: {check: async (key) => (await listMcpTools(PARALLEL, key)).map(() => undefined)},
	defaults: ['search', 'fetch'],
	tools: {
		web_search: {
			actions: ['search'],
			run: (params) => ({collectionId: 'searches', operation: 'run', title: textParam(params, 'objective') ?? firstParam(params, 'search_queries')}),
		},
		web_fetch: {actions: ['fetch'], run: (params) => ({collectionId: 'pages', operation: 'read', title: firstParam(params, 'urls')})},
	},
};
