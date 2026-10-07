import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';

import {callMcpTool} from '../mcp/mcp-client';
import type {McpServer, McpSignIn} from '../mcp/mcp-oauth';

/**
 * Notion's MCP server and what its tools answer: JSON, a page's own text inside it as Notion writes
 * it for models, `<properties>` as JSON and `<content>` as Notion-flavored Markdown. A sign-in is
 * for one workspace, as the person who signed in, and lasts at most 180 days, however often its
 * tokens are refreshed; after that the connection has to be signed in again.
 */

const BASE = 'https://mcp.notion.com';

// What a failed tool says: `{"code": "object_not_found", "message": "Could not find page…"}`.
const toolFailureSchema = z.object({code: z.string(), message: z.string().optional()});

function notionToolError(text: string): ApiError | null {
	const failure = parseJson(text, toolFailureSchema);
	if (failure.isErr()) {
		return null;
	}
	if (failure.value.code === 'object_not_found') {
		return ApiErr.notFound('page');
	}
	if (failure.value.code === 'validation_error') {
		return ApiErr.validationError(`Notion turned it down: ${failure.value.message ?? 'not valid'}`);
	}
	return null;
}

export const NOTION: McpServer = {
	name: 'Notion',
	url: `${BASE}/mcp`,
	registerUrl: `${BASE}/register`,
	authorizeUrl: `${BASE}/authorize`,
	tokenUrl: `${BASE}/token`,
	scope: 'default',
	toolError: notionToolError,
};

function parseJson<T>(text: string, schema: z.ZodType<T>): Result<T, ApiError> {
	return Result.wrap((): unknown => JSON.parse(text))
		.mapErr((cause) => ApiErr.providerUnreachable(cause))
		.andThen((json) => parseSchema(schema, json).mapErr((error) => ApiErr.providerUnreachable(error)));
}

const usersSchema = z.object({results: z.array(z.object({name: z.string().optional(), email: z.string().optional()}))});

/**
 * The Notion account a sign-in is for, by who signed in and the workspace they chose:
 * "alex@example.com · Acme". Signing in to another workspace is another connection.
 */
export function getNotionAccount(signIn: McpSignIn): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const text = $(await callMcpTool(NOTION, signIn.credential.accessToken, 'notion-get-users', {user_id: 'self'}));
		const user = $(parseJson(text, usersSchema)).results[0];
		const who = user?.email?.toLowerCase() ?? user?.name;
		if (!who) {
			return $(Err(ApiErr.providerUnreachable(new Error('Notion did not say who signed in'))));
		}
		return signIn.workspaceName ? `${who} · ${signIn.workspaceName}` : who;
	});
}

// Notion's page ids, 32 hex digits, written with or without dashes.
const PAGE_ID = /^[0-9a-f]{32}$/;

/** A page id as Personal Agent Proxy writes it, 32 hex digits without dashes; null when it isn't one. */
export function notionPageId(id: string): string | null {
	const plain = id.replace(/-/g, '').toLowerCase();
	return PAGE_ID.test(plain) ? plain : null;
}

// The id at the end of a page's address: `https://app.notion.com/p/3e4955a63d7e8069a438e7961ef050ef?pvs=204`.
function idOfUrl(url: string): string | null {
	const match = /([0-9a-f]{32})$/i.exec(URL.canParse(url) ? new URL(url).pathname : '');
	return match?.[1] ? match[1].toLowerCase() : null;
}

// A page's address without what Notion adds for its own tracking.
function plainUrl(url: string): string {
	if (!URL.canParse(url)) {
		return url;
	}
	const parsed = new URL(url);
	parsed.search = '';
	return parsed.toString();
}

export type NotionPageRow = {
	id: string;
	title: string;
	url: string;
	// Where the page is, "Outreach / Companies"; empty at the top of the workspace or when Notion doesn't say.
	path: string;
	// The day it was last edited, `2026-09-24`, where Notion says.
	day: string | null;
};

// Pages and databases alike, and, from search, what it finds in other tools connected to Notion.
const listedSchema = z.object({
	type: z.string(),
	id: z.string().optional(),
	url: z.string().optional(),
	title: z.string().optional(),
	path: z.string().optional(),
	// "13 days ago (2026-09-24)".
	timestamp: z.string().optional(),
});

const recentSchema = z.object({results: z.array(listedSchema), nextCursor: z.string().nullish()});
const searchSchema = z.object({results: z.array(listedSchema)});

function pageRows(results: Array<z.infer<typeof listedSchema>>): NotionPageRow[] {
	return results.flatMap((result) => {
		const id = (result.id && notionPageId(result.id)) || (result.url && idOfUrl(result.url));
		if (result.type !== 'page' || !id) {
			return [];
		}
		return [
			{
				id,
				title: result.title || 'Untitled',
				url: result.url ? plainUrl(result.url) : '',
				path: result.path ?? '',
				day: /\((\d{4}-\d{2}-\d{2})\)/.exec(result.timestamp ?? '')?.[1] ?? null,
			},
		];
	});
}

/** The pages in a `notion-list-recent-pages` answer, as Notion orders them, and its next page's cursor. */
export function parseNotionRecent(text: string): Result<{pages: NotionPageRow[]; nextCursor: string | null}, ApiError> {
	return parseJson(text, recentSchema).map((answer) => ({pages: pageRows(answer.results), nextCursor: answer.nextCursor ?? null}));
}

/** The pages in a `notion-search` answer, best match first; databases and other tools' results left out. */
export function parseNotionSearch(text: string): Result<NotionPageRow[], ApiError> {
	return parseJson(text, searchSchema).map((answer) => pageRows(answer.results));
}

export type NotionPage = {
	id: string;
	title: string;
	url: string;
	path: string;
	// When it was last edited, as an ISO time; empty when Notion doesn't say.
	edited: string;
	// A database row's properties, "Name: value" a line.
	properties: string;
	content: string;
};

const fetchedSchema = z.object({
	metadata: z.object({type: z.string()}),
	title: z.string().optional(),
	url: z.string().optional(),
	path: z.string().optional(),
	icon: z.object({type: z.string(), emoji: z.string().optional()}).nullish(),
	page_last_edited_at: z.string().optional(),
	text: z.string(),
});

const propertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const propertiesSchema = z.record(z.string(), propertyValueSchema);

// What a property holds, written out; Notion leaves rollups and formulas as references it doesn't resolve.
function propertyText(value: z.infer<typeof propertyValueSchema>): string {
	if (value === null) {
		return '';
	}
	const text = Array.isArray(value) ? value.join(', ') : String(value);
	return /^(rollupResult|formulaResult):\/\//.test(text) ? '' : text;
}

// One "Name: value" a line, empty ones and the title left out, and the page's address Notion adds.
function propertyLines(json: string, title: string): Result<string, ApiError> {
	return parseJson(json, propertiesSchema).map((properties) =>
		Object.entries(properties)
			.filter(([name]) => name !== 'title' && name !== 'url')
			.map(([name, value]) => [name, propertyText(value)] as const)
			.filter(([, text]) => text !== '' && text !== title)
			.map(([name, text]) => `${name}: ${text}`)
			.join('\n'),
	);
}

// What is between an element's tags in a fetched page, as Notion wrote it; null when it isn't there.
// The content runs to its last closing tag, since what is written in it can hold one too.
function between(text: string, tag: 'properties' | 'content'): string | null {
	const open = `<${tag}>\n`;
	const close = `\n</${tag}>`;
	const start = text.indexOf(open);
	const end = tag === 'content' ? text.lastIndexOf(close) : text.indexOf(close, start);
	if (start === -1 || end < start + open.length) {
		return null;
	}
	return text.slice(start + open.length, end);
}

/** A page out of a `notion-fetch` answer; not found when what was fetched isn't a page, such as a database. */
export function parseNotionPage(text: string): Result<NotionPage, ApiError> {
	return parseJson(text, fetchedSchema).andThen((fetched) => {
		const id = fetched.url ? idOfUrl(fetched.url) : null;
		if (fetched.metadata.type !== 'page' || !id) {
			return Err(ApiErr.notFound('page'));
		}
		return pageOf(id, fetched);
	});
}

function pageOf(id: string, fetched: z.infer<typeof fetchedSchema>): Result<NotionPage, ApiError> {
	return Do<NotionPage, ApiError>(($) => {
		// Notion puts an emoji icon before the title.
		const emoji = fetched.icon?.emoji;
		const title = (emoji && fetched.title?.startsWith(`${emoji} `) ? fetched.title.slice(emoji.length + 1) : fetched.title) || 'Untitled';
		const properties = between(fetched.text, 'properties');
		return {
			id,
			title,
			url: fetched.url ? plainUrl(fetched.url) : '',
			path: fetched.path ?? '',
			edited: fetched.page_last_edited_at ?? '',
			properties: properties === null ? '' : $(propertyLines(properties, title)),
			content: between(fetched.text, 'content') ?? '',
		};
	});
}

/** The page a `notion-create-pages` answer made: the first page address or id in it. */
export function parseNotionCreated(text: string): Result<string, ApiError> {
	const match = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i.exec(text);
	const id = match?.[1] ? notionPageId(match[1]) : null;
	if (!id) {
		return Err(ApiErr.providerUnreachable(new Error(`Notion did not say which page it made: ${text.slice(0, 200)}`)));
	}
	return Ok(id);
}
