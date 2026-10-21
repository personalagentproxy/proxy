import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {EXA, parseExaPage} from '../connections/exa/exa-mcp';
import type {McpServer} from '../connections/mcp/mcp-oauth';
import {callMcpToolFor} from '../connections/mcp/mcp-session';
import {formatParallelResults, parseParallelPage, PARALLEL} from '../connections/parallel/parallel-mcp';
import {onlyRun, type Connector, type DataRecord} from './connector';

/**
 * The web, through a search engine made for agents, Exa or Parallel, fetched live from its MCP
 * server with the connection's tokens. Searches and pages are only run, never listed, opened or
 * kept: a search answers with the provider's results, written out the same way for both, a page
 * with its title and text, the first MAX_PAGE_CHARACTERS of it.
 */

const MAX_PAGE_CHARACTERS = 100_000;

type Page = {title: string; content: string};

// One of a provider's tools: its name, what it is called with, and what is made of its answer.
type ToolUse<T> = {tool: string; args: Record<string, string | string[] | number | boolean>; answer: (text: string) => Result<T, ApiError>};

type WebProvider = {
	server: McpServer;
	search: (query: string) => ToolUse<string>;
	read: (url: string) => ToolUse<Page>;
};

// Exa takes the query both as what to find and as why, and stops reading a page where it is cut.
const EXA_WEB: WebProvider = {
	server: EXA,
	search: (query) => ({tool: 'web_search_exa', args: {query, objective: query}, answer: (text) => Ok(text)}),
	read: (url) => ({tool: 'web_fetch_exa', args: {urls: [url], maxCharacters: MAX_PAGE_CHARACTERS}, answer: (text) => Ok(parseExaPage(text))}),
};

// Parallel takes the query both as what to find and as its one search, and reads a page in full.
const PARALLEL_WEB: WebProvider = {
	server: PARALLEL,
	search: (query) => ({tool: 'web_search', args: {objective: query, search_queries: [query]}, answer: formatParallelResults}),
	read: (url) => ({tool: 'web_fetch', args: {urls: [url], full_content: true}, answer: (text) => parseParallelPage(text, url)}),
};

// An address a provider can read: `http` or `https`.
function pageUrl(raw: string): Result<string, ApiError> {
	const trimmed = raw.trim();
	if (!URL.canParse(trimmed) || !['http:', 'https:'].includes(new URL(trimmed).protocol)) {
		return Err(ApiErr.validationError('Give the page’s address, such as https://example.com'));
	}
	return Ok(trimmed);
}

function webConnector(provider: WebProvider): Connector {
	const use = <T>(connection: {id: string; credential: string | null}, {tool, args, answer}: ToolUse<T>): Promise<Result<T, ApiError>> =>
		Do(async ($) => $(answer($(await callMcpToolFor(provider.server, connection, tool, args)))));

	return {
		...onlyRun('Searches and pages are only run, never listed or kept'),
		newCommands: {
			run: (target, values) =>
				Do(async ($): Promise<DataRecord> => {
					const query = (values.query ?? '').trim();
					if (!query) {
						return $(Err(ApiErr.validationError('Say what to search for')));
					}
					const results = $(await use(target.connection, provider.search(query)));
					return {id: 'search', values: {query, results}, updatedAt: new Date().toISOString()};
				}),
			read: (target, values) =>
				Do(async ($): Promise<DataRecord> => {
					const url = $(pageUrl(values.url ?? ''));
					const page = $(await use(target.connection, provider.read(url)));
					return {id: 'page', values: {url, title: page.title, content: page.content.slice(0, MAX_PAGE_CHARACTERS)}, updatedAt: new Date().toISOString()};
				}),
		},
	};
}

export const exaConnector = webConnector(EXA_WEB);

export const parallelConnector = webConnector(PARALLEL_WEB);
