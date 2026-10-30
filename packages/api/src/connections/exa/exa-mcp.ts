import {ApiErr, type ApiError} from '@proxy/utils';

import type {McpServer} from '../mcp/mcp-oauth';
import {httpPageFailure, pageError, type PageFailure} from '../page-failure';

/**
 * Exa's MCP server and what its tools answer: text made for models. A search is its results, one
 * a block ("Title: …", "URL: …", "Published: …", "Highlights:" and the passages), the blocks
 * between "---" lines; a page is "# Title", "URL: …" and its text as Markdown, cut without a word
 * where it reaches `maxCharacters`. A tool that fails says why in words; a page that couldn't be
 * read, its address and a code: "Error fetching URL(s): https://example.com/gone: CRAWL_NOT_FOUND".
 */

const AUTH_BASE = 'https://auth.exa.ai';

export const EXA: McpServer = {
	name: 'Exa',
	url: 'https://mcp.exa.ai/mcp',
	registerUrl: `${AUTH_BASE}/api/oauth/register`,
	authorizeUrl: `${AUTH_BASE}/oauth/authorize`,
	tokenUrl: `${AUTH_BASE}/api/oauth/token`,
	scope: 'mcp:tools',
	toolError: exaToolError,
};

// "Error fetching URL(s): https://example.com/gone: CRAWL_NOT_FOUND", for the one page read.
const FETCH_ERROR = /^Error fetching URL\(s\): (.+): (CRAWL_[A-Z0-9_]+)$/;
const HTTP_CODE = /^CRAWL_HTTP_(\d{3})$/;

// What a page's code says of it, where it is a failure of a known kind: one Exa's crawler had
// from the site, as CRAWL_HTTP_403, or of its own. Others, as CRAWL_UNKNOWN_ERROR for an address
// that doesn't resolve, say nothing an agent could act on.
function crawlFailure(code: string): PageFailure | null {
	if (code === 'CRAWL_NOT_FOUND') {
		return {kind: 'missing'};
	}
	if (code === 'CRAWL_LIVECRAWL_TIMEOUT') {
		return {kind: 'timeout'};
	}
	if (code === 'CRAWL_EMPTY_CONTENT') {
		return {kind: 'empty'};
	}
	if (code === 'CRAWL_UNEXPECTED_CONTENT_TYPE') {
		return {kind: 'unsupported'};
	}
	const status = HTTP_CODE.exec(code)?.[1];
	return status ? httpPageFailure(Number(status)) : null;
}

// A page Exa couldn't read, by its code, with the address; a key Exa turns down fails the call,
// not the request: "web_search_exa error (401): Invalid API key."; anything else in Exa's words.
function exaToolError(text: string): ApiError {
	const fetchError = FETCH_ERROR.exec(text.trim());
	const failure = fetchError?.[2] ? crawlFailure(fetchError[2]) : null;
	if (fetchError?.[1] && failure) {
		return pageError('Exa', fetchError[1], failure);
	}
	if (/\(401\)|invalid api key/i.test(text)) {
		return ApiErr.credentialsRejected();
	}
	return ApiErr.validationError(`Exa turned it down: ${text.trim() || 'it didn’t say why'}`);
}

const PAGE_HEADING = /^# (.*)\nURL: .*\n+/;

// What `web_fetch_exa` answers, not as an error, when Exa read nothing and had no code for why.
const NO_CONTENT = 'No content found for the provided URL(s).';

/**
 * A page's title and text out of what `web_fetch_exa` answers; all of it the text when it has no
 * heading, and none when Exa found nothing.
 */
export function parseExaPage(text: string): {title: string; content: string} {
	if (text.trim() === NO_CONTENT) {
		return {title: '', content: ''};
	}
	const heading = PAGE_HEADING.exec(text);
	if (!heading) {
		return {title: '', content: text.trim()};
	}
	return {title: heading[1]?.trim() ?? '', content: text.slice(heading[0].length).trim()};
}
