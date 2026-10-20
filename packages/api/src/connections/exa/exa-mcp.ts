import {ApiErr} from '@proxy/utils';

import type {McpServer} from '../mcp/mcp-oauth';

/**
 * Exa's MCP server and what its tools answer: text made for models. A search is its results, one
 * a block ("Title: …", "URL: …", "Published: …", "Highlights:" and the passages), the blocks
 * between "---" lines; a page is "# Title", "URL: …" and its text as Markdown. A tool that fails
 * says why in words: "Error fetching URL(s): …".
 */

const AUTH_BASE = 'https://auth.exa.ai';

export const EXA: McpServer = {
	name: 'Exa',
	url: 'https://mcp.exa.ai/mcp',
	registerUrl: `${AUTH_BASE}/api/oauth/register`,
	authorizeUrl: `${AUTH_BASE}/oauth/authorize`,
	tokenUrl: `${AUTH_BASE}/api/oauth/token`,
	scope: 'mcp:tools',
	// A key Exa turns down fails the call, not the request: "web_search_exa error (401): Invalid API key."
	toolError: (text) => (/\(401\)|invalid api key/i.test(text) ? ApiErr.credentialsRejected() : ApiErr.validationError(`Exa turned it down: ${text.trim() || 'it didn’t say why'}`)),
};

const PAGE_HEADING = /^# (.*)\nURL: .*\n+/;

/** A page's title and text out of what `web_fetch_exa` answers; all of it the text when it has no heading. */
export function parseExaPage(text: string): {title: string; content: string} {
	const heading = PAGE_HEADING.exec(text);
	if (!heading) {
		return {title: '', content: text.trim()};
	}
	return {title: heading[1]?.trim() ?? '', content: text.slice(heading[0].length).trim()};
}
