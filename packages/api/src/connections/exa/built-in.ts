import {Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

import {firstParam, textParam, type BuiltInMcp} from '../mcp/built-in';
import {callMcpTool} from '../mcp/mcp-client';
import type {McpServer} from '../mcp/mcp-oauth';
import {EXA} from './exa-mcp';

// A key's check, a page read with it, that Exa's tool failed for anything but the key, as a page
// it couldn't read; told apart from a request Exa turned down, such as a 403 for a permission the
// key lacks, which fails the check.
const PAGE_NOT_READ = ApiErr.validationError('Exa couldn’t read the page');

const EXA_CHECK: McpServer = {...EXA, toolError: (text) => (EXA.toolError?.(text)?.kind === 'credentials_rejected' ? ApiErr.credentialsRejected() : PAGE_NOT_READ)};

/**
 * Exa, through its MCP server, as Granola, Notion and Linear are, signed in to or given an API key.
 * Exa says nothing of who signed in, so the person names each connection, and an organization can
 * have as many as it likes. A new Exa connection lets agents search the web and read pages.
 */
export const EXA_MCP: BuiltInMcp = {
	integrationId: 'exa',
	server: EXA,
	// Exa answers anyone until a tool is called, so a key is checked by reading a small page with it,
	// which costs the key a page's read. A page Exa couldn't read, or any other failure of the tool
	// but the key's, says nothing against the key; a key Exa turns down, or a request it refuses
	// the key, fails the check.
	apiKey: {
		check: async (key) => {
			const read = await callMcpTool(EXA_CHECK, key, 'web_fetch_exa', {urls: ['https://example.com'], maxCharacters: 100});
			if (read.isErr() && read.error === PAGE_NOT_READ) {
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
