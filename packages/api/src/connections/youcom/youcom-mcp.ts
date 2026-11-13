import {z} from 'zod';
import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {parseToolJson} from '../mcp/mcp-client';
import type {McpServer} from '../mcp/mcp-oauth';

/**
 * You.com's MCP server, at the address that takes a sign-in or an API key (its keyless free
 * profile is the same address with `?profile=free`, which has no page reads), and what its tools
 * answer: JSON, a search's results each a page's address, title, description, page age and the
 * passages that fit, and a page read its text as Markdown, or nothing where it couldn't be read.
 * Results are written out as Exa writes its own, so an agent reads all three the same.
 */

const AUTH_BASE = 'https://auth.you.com';
const APP = 'P2jInttRMuXpyYZMbVcsc4C9Z0RT/MS3BitzWFxlSigWFUNJHHNsIYt5qp';

export const YOUCOM: McpServer = {
	name: 'You.com',
	url: 'https://api.you.com/mcp',
	registerUrl: `${AUTH_BASE}/v1/mgmt/mcp/client/${APP}/register`,
	authorizeUrl: `${AUTH_BASE}/oauth2/v1/apps/agentic/${APP}/authorize`,
	tokenUrl: `${AUTH_BASE}/oauth2/v1/apps/agentic/${APP}/token`,
	scope: 'Tools offline_access',
	// So You.com can tell requests from this integration apart; sent to You.com only.
	headers: {'user-agent': 'youdotcom-integration/personalagentproxy-proxy'},
	toolError: youcomToolError,
};

// A key You.com turns down fails the call, not the request: "Error: Authentication failed: Invalid or
// expired API key. …", or "Error: Failed to perform search. Error code: 401"; anything else in its words.
function youcomToolError(text: string): ApiError {
	if (/authentication failed|invalid or expired api key|error code: (401|403)\b/i.test(text)) {
		return ApiErr.credentialsRejected();
	}
	return ApiErr.validationError(`You.com turned it down: ${text.replace(/^Error:\s*/, '').trim() || 'it didn’t say why'}`);
}

const webResultSchema = z.object({
	url: z.string().nullish(),
	title: z.string().nullish(),
	description: z.string().nullish(),
	// `2026-10-13T00:00:00`.
	page_age: z.string().nullish(),
	snippets: z.array(z.string()).nullish(),
	contents: z.object({highlights: z.array(z.string()).nullish()}).nullish(),
});

const searchSchema = z.object({
	results: z
		.object({
			web: z.array(webResultSchema).nullish(),
			news: z.array(webResultSchema).nullish(),
		})
		.nullish(),
});

// The passages that fit, as You.com gives them: highlights where it extracted them, else snippets, else the description.
function passages(result: z.infer<typeof webResultSchema>): string[] {
	const highlights = result.contents?.highlights?.filter(Boolean) ?? [];
	if (highlights.length > 0) {
		return highlights;
	}
	const snippets = result.snippets?.filter(Boolean) ?? [];
	if (snippets.length > 0) {
		return snippets;
	}
	return result.description ? [result.description] : [];
}

/** A `you-search` answer written out as Exa writes its results: a block a page, between "---" lines; web results first, then news. */
export function formatYoucomResults(text: string): Result<string, ApiError> {
	return parseToolJson(text, searchSchema).map(({results}) =>
		[...(results?.web ?? []), ...(results?.news ?? [])]
			.filter((result): result is typeof result & {url: string} => Boolean(result.url))
			.map((result) =>
				[`Title: ${result.title || result.url}`, `URL: ${result.url}`, `Published: ${result.page_age?.slice(0, 10) || 'N/A'}`, 'Highlights:', passages(result).join('\n...\n')].join('\n'),
			)
			.join('\n\n---\n\n'),
	);
}

const pageSchema = z.object({url: z.string(), title: z.string().nullish(), markdown: z.string().nullish(), html: z.string().nullish()});

// `{"output": [{url, title, markdown}]}`, one entry a page asked for.
const contentsSchema = z.union([z.object({output: z.array(pageSchema)}), z.array(pageSchema).transform((output) => ({output}))]);

/**
 * The page in a `you-contents` answer for `url`: its title and Markdown, matched by address where
 * You.com gives it back as asked, else the one entry; no text where You.com read nothing, which the
 * caller fails as a page with no text.
 */
export function parseYoucomPage(text: string, url: string): Result<{title: string; content: string}, ApiError> {
	return parseToolJson(text, contentsSchema).map(({output}) => {
		const page = output.find((entry) => entry.url === url) ?? output[0];
		return {title: page?.title?.trim() ?? '', content: (page?.markdown ?? '').trim()};
	});
}
