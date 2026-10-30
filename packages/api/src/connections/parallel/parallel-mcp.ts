import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError} from '@proxy/utils';

import {parseToolJson} from '../mcp/mcp-client';
import type {McpServer} from '../mcp/mcp-oauth';
import {httpPageFailure, pageError} from '../page-failure';

/**
 * Parallel's MCP server, at the address that takes a sign-in or an API key (its keyless one is
 * `/mcp` beside it), and what its tools answer: JSON, a search's results each a page's address,
 * title, publish date and the passages that fit, and a page read in full its text as Markdown,
 * whole however long, or why it couldn't be read. Results are written out as Exa writes its own, so an agent reads both
 * the same.
 */

const AUTH_BASE = 'https://platform.parallel.ai/getKeys';

export const PARALLEL: McpServer = {
	name: 'Parallel',
	url: 'https://search.parallel.ai/mcp-oauth',
	registerUrl: `${AUTH_BASE}/register`,
	authorizeUrl: `${AUTH_BASE}/authorize`,
	tokenUrl: `${AUTH_BASE}/token`,
	scope: 'key:read',
	toolError: (text) => ApiErr.validationError(`Parallel turned it down: ${text.trim() || 'it didn’t say why'}`),
};

const resultSchema = z.object({
	url: z.string(),
	title: z.string().nullish(),
	// `2026-10-13`.
	publish_date: z.string().nullish(),
	excerpts: z.array(z.string()).nullish(),
	// Only when asked for.
	full_content: z.string().nullish(),
});

const searchSchema = z.object({results: z.array(resultSchema)});

// What `web_fetch` couldn't read: `{"url": "…", "error_type": "connect_error", "http_status_code": null}`,
// or `"http_error"` with the site's status, as 404.
const fetchSchema = z.object({
	results: z.array(resultSchema),
	errors: z.array(z.object({url: z.string(), error_type: z.string(), http_status_code: z.number().nullish()})).nullish(),
});

/** A `web_search` answer written out as Exa writes its results: a block a page, between "---" lines. */
export function formatParallelResults(text: string): Result<string, ApiError> {
	return parseToolJson(text, searchSchema).map(({results}) =>
		results
			.map((result) => [`Title: ${result.title || result.url}`, `URL: ${result.url}`, `Published: ${result.publish_date ?? 'N/A'}`, 'Highlights:', (result.excerpts ?? []).join('\n...\n')].join('\n'))
			.join('\n\n---\n\n'),
	);
}

/**
 * The page in a `web_fetch` answer for `url`, or why Parallel couldn't read it: by the site's
 * status where it is a failure of a known kind, else in Parallel's words.
 */
export function parseParallelPage(text: string, url: string): Result<{title: string; content: string}, ApiError> {
	return parseToolJson(text, fetchSchema).andThen((answer): Result<{title: string; content: string}, ApiError> => {
		const page = answer.results[0];
		if (!page) {
			const error = answer.errors?.[0];
			const failure = error?.http_status_code ? httpPageFailure(error.http_status_code) : null;
			if (failure) {
				return Err(pageError('Parallel', url, failure));
			}
			const status = error?.http_status_code ? ` (HTTP ${error.http_status_code})` : '';
			return Err(ApiErr.validationError(`Parallel couldn’t read ${url}: ${error?.error_type ?? 'it didn’t say why'}${status}`));
		}
		return Ok({title: page.title ?? '', content: (page.full_content ?? (page.excerpts ?? []).join('\n\n')).trim()});
	});
}
