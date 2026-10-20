import {Ok} from 'ts-results-es';

import {firstParam, textParam, type BuiltInMcp} from '../mcp/built-in';
import {callMcpTool} from '../mcp/mcp-client';
import {EXA} from './exa-mcp';

/**
 * Exa, through its MCP server, as Granola, Notion and Linear are, signed in to or given an API key.
 * Exa says nothing of who signed in, so the person names each connection, and an organization can
 * have as many as it likes. A new Exa connection lets agents search the web and read pages.
 */
export const EXA_MCP: BuiltInMcp = {
	integrationId: 'exa',
	server: EXA,
	// Exa answers anyone until a tool is called, so a key is checked by reading a small page with it,
	// which costs the key a page's read. Only a key Exa turns down fails the check: a page it
	// couldn't read, or any other refusal of the tool, says nothing against the key.
	apiKey: {
		check: async (key) => {
			const read = await callMcpTool(EXA, key, 'web_fetch_exa', {urls: ['https://example.com'], maxCharacters: 100});
			if (read.isErr() && read.error.kind === 'validation_error') {
				return Ok(undefined);
			}
			return read.map(() => undefined);
		},
		addressParam: 'exaApiKey',
	},
	defaults: ['search', 'fetch'],
	tools: {
		web_search_exa: {actions: ['search'], run: (params) => ({collectionId: 'searches', operation: 'run', title: textParam(params, 'query')})},
		web_search_advanced_exa: {actions: ['search'], run: (params) => ({collectionId: 'searches', operation: 'run', title: textParam(params, 'query')})},
		web_fetch_exa: {actions: ['fetch'], run: (params) => ({collectionId: 'pages', operation: 'read', title: firstParam(params, 'urls')})},
	},
};
