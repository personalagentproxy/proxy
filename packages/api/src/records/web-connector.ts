import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {EXA, parseExaPage} from '../connections/exa/exa-mcp';
import {formatKeenableResults, KEENABLE, parseKeenablePage} from '../connections/keenable/keenable-mcp';
import type {McpServer} from '../connections/mcp/mcp-oauth';
import {callMcpToolFor} from '../connections/mcp/mcp-session';
import {pageError} from '../connections/page-failure';
import {formatParallelResults, parseParallelPage, PARALLEL} from '../connections/parallel/parallel-mcp';
import type {DataRecord, RunOnly} from './connector';

/**
 * The web, through a search engine made for agents, Exa, Parallel or Keenable, fetched live from
 * its MCP server with the connection's tokens, as two collections, `searches` and `pages`, only
 * run, never listed, opened or kept: a search answers with the provider's results, written out the
 * same way for each, a page with its title and text, the first MAX_PAGE_CHARACTERS of it and a line
 * after them saying it was cut where it goes on. A page with no text is a failure.
 */

const MAX_PAGE_CHARACTERS = 100_000;

// Exa is asked for a little more of a page than is kept, so one that goes on past what is kept is
// told from one that ends there whatever space it trims at the end.
const EXA_PAGE_CHARACTERS = MAX_PAGE_CHARACTERS + 1_000;

type Page = {title: string; content: string};

// One of a provider's tools: its name, what it is called with, and what is made of its answer.
type ToolUse<T> = {tool: string; args: Record<string, string | string[] | number | boolean>; answer: (text: string) => Result<T, ApiError>};

type WebProvider = {
	server: McpServer;
	search: (query: string) => ToolUse<string>;
	read: (url: string) => ToolUse<Page>;
	// Whether a page comes whole, so a cut one can say how long it was.
	readsWhole: boolean;
};

// Exa takes the query both as what to find and as why, and stops reading a page where it is cut.
const EXA_WEB: WebProvider = {
	server: EXA,
	search: (query) => ({tool: 'web_search_exa', args: {query, objective: query}, answer: (text) => Ok(text)}),
	read: (url) => ({tool: 'web_fetch_exa', args: {urls: [url], maxCharacters: EXA_PAGE_CHARACTERS}, answer: (text) => Ok(parseExaPage(text))}),
	readsWhole: false,
};

// Parallel takes the query both as what to find and as its one search, and reads a page in full.
const PARALLEL_WEB: WebProvider = {
	server: PARALLEL,
	search: (query) => ({tool: 'web_search', args: {objective: query, search_queries: [query]}, answer: formatParallelResults}),
	read: (url) => ({tool: 'web_fetch', args: {urls: [url], full_content: true}, answer: (text) => parseParallelPage(text, url)}),
	readsWhole: true,
};

// Keenable takes the query as it is, stops reading a page where it is cut, asked for as much of it
// as Exa is, and answers both as JSON.
const KEENABLE_WEB: WebProvider = {
	server: KEENABLE,
	search: (query) => ({tool: 'search_web_pages', args: {query, output_format: 'json'}, answer: formatKeenableResults}),
	read: (url) => ({tool: 'fetch_page_content', args: {url, max_chars: EXA_PAGE_CHARACTERS, output_format: 'json'}, answer: parseKeenablePage}),
	readsWhole: false,
};

// An address a provider can read: `http` or `https`.
function pageUrl(raw: string): Result<string, ApiError> {
	const trimmed = raw.trim();
	if (!URL.canParse(trimmed) || !['http:', 'https:'].includes(new URL(trimmed).protocol)) {
		return Err(ApiErr.validationError('Give the page’s address, such as https://example.com'));
	}
	return Ok(trimmed);
}

// A page that was read, or why it is no page: it has no text.
function requireText(provider: WebProvider, url: string, page: Page): Result<Page, ApiError> {
	if (!page.content) {
		return Err(pageError(provider.server.name, url, {kind: 'empty'}));
	}
	return Ok(page);
}

// A page's text, whole, or its start and a line after it saying it goes on, and how to read less
// of it, so a cut page never reads as all of it.
function keptText(provider: WebProvider, content: string): string {
	if (content.length <= MAX_PAGE_CHARACTERS) {
		return content;
	}
	const kept = MAX_PAGE_CHARACTERS.toLocaleString('en-US');
	const length = provider.readsWhole ? `is ${content.length.toLocaleString('en-US')} characters long` : `goes on past ${kept} characters`;
	return `${content.slice(0, MAX_PAGE_CHARACTERS)}\n\n[Cut short: the page ${length}, of which these are the first ${kept}. Read a part of it at its own address, such as one section or chapter, or search for the passage you need with searches_run.]`;
}

// The provider's two collections: its searches, run on a query, and its pages, read by address.
function webConnectors(provider: WebProvider): {searches: RunOnly; pages: RunOnly} {
	const use = <T>(connection: {id: string; credential: string | null}, {tool, args, answer}: ToolUse<T>): Promise<Result<T, ApiError>> =>
		Do(async ($) => $(answer($(await callMcpToolFor(provider.server, connection, tool, args)))));

	return {
		searches: {
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
			},
		},
		pages: {
			newCommands: {
				read: (target, values) =>
					Do(async ($): Promise<DataRecord> => {
						const url = $(pageUrl(values.url ?? ''));
						const page = $(requireText(provider, url, $(await use(target.connection, provider.read(url)))));
						return {id: 'page', values: {url, title: page.title, content: keptText(provider, page.content)}, updatedAt: new Date().toISOString()};
					}),
			},
		},
	};
}

export const exaConnectors = webConnectors(EXA_WEB);

export const parallelConnectors = webConnectors(PARALLEL_WEB);

export const keenableConnectors = webConnectors(KEENABLE_WEB);
