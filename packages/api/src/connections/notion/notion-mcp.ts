import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';

import {callMcpTool} from '../mcp/mcp-client';
import type {McpServer, McpSignIn} from '../mcp/mcp-oauth';

/**
 * Notion's MCP server and what its tools answer: JSON, a page's own text inside it as Notion writes
 * it for models, `<properties>` as JSON and `<content>` as Notion-flavored Markdown, a database's
 * as tags around its views and data sources. A sign-in is for one workspace, as the person who
 * signed in, and lasts at most 180 days, however often its tokens are refreshed; after that the
 * connection has to be signed in again.
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

// Notion's ids, 32 hex digits, written with or without dashes.
const HEX_ID = /^[0-9a-f]{32}$/;

function plainId(id: string): string | null {
	const plain = id.replace(/-/g, '').toLowerCase();
	return HEX_ID.test(plain) ? plain : null;
}

/** An id as Notion's tools take it, `3e4955a6-3d7e-8069-a438-e7961ef050ef`. */
export function dashedId(id: string): string {
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * What a record id names: a page or a database by its own id, 32 hex digits, or a database's saved
 * view, `view-` and the view's; null when it is neither.
 */
export type NotionRef = {kind: 'node'; id: string} | {kind: 'view'; id: string};

export function parseNotionRef(recordId: string): NotionRef | null {
	if (recordId.startsWith('view-')) {
		const id = plainId(recordId.slice('view-'.length));
		return id ? {kind: 'view', id} : null;
	}
	const id = plainId(recordId);
	return id ? {kind: 'node', id} : null;
}

// Notion wraps some addresses in braces for models to copy: `{{collection://…}}`.
function unwrap(url: string): string {
	return url.replace(/^\{\{/, '').replace(/\}\}$/, '');
}

// The id at the end of a page's or database's address: `https://app.notion.com/p/3e4955a63d7e8069a438e7961ef050ef?pvs=204`.
function idOfUrl(url: string): string | null {
	const plain = unwrap(url);
	const match = /([0-9a-f]{32})$/i.exec(URL.canParse(plain) ? new URL(plain).pathname : '');
	return match?.[1] ? match[1].toLowerCase() : null;
}

// The id in a data source's or view's address: `collection://3e4955a6-3d7e-8086-b78e-000b4f38d6a4`.
function idOfRef(url: string): string | null {
	const match = /^[a-z]+:\/\/([0-9a-f-]{32,36})$/i.exec(unwrap(url));
	return match?.[1] ? plainId(match[1]) : null;
}

// A page's address without what Notion adds for its own tracking.
function plainUrl(url: string): string {
	const plain = unwrap(url);
	if (!URL.canParse(plain)) {
		return plain;
	}
	const parsed = new URL(plain);
	parsed.search = '';
	return parsed.toString();
}

const ENTITIES: Record<string, string> = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'"};

function decode(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|#39|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

// A tag's attributes, as Notion writes them: `url="…" title="…"`.
function attributes(tag: string): Record<string, string> {
	return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], decode(match[2] ?? '')]));
}

export type NotionKind = 'Page' | 'Database' | 'View';

/** A page, database or view as a list shows it, its record id as Personal Agent Proxy writes it. */
export type NotionNode = {
	id: string;
	kind: NotionKind;
	title: string;
	url: string;
	// Where it is, "Outreach / Companies"; empty at the top of the workspace or when Notion doesn't say.
	path: string;
	// The day it was last edited, `2026-09-24`, where Notion says.
	day: string | null;
};

/** A record a list was opened in, or one above it. */
export type NotionCrumb = {id: string; title: string};

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

function listedNodes(results: Array<z.infer<typeof listedSchema>>): NotionNode[] {
	return results.flatMap((result) => {
		const id = (result.id && plainId(result.id)) || (result.url && idOfUrl(result.url));
		if ((result.type !== 'page' && result.type !== 'database') || !id) {
			return [];
		}
		return [
			{
				id,
				kind: result.type === 'page' ? 'Page' : 'Database',
				title: result.title || 'Untitled',
				url: result.url ? plainUrl(result.url) : '',
				path: result.path ?? '',
				day: /\((\d{4}-\d{2}-\d{2})\)/.exec(result.timestamp ?? '')?.[1] ?? null,
			},
		];
	});
}

/** The pages and databases in a `notion-list-recent-pages` answer, as Notion orders them, and its next page's cursor. */
export function parseNotionRecent(text: string): Result<{nodes: NotionNode[]; nextCursor: string | null}, ApiError> {
	return parseJson(text, recentSchema).map((answer) => ({nodes: listedNodes(answer.results), nextCursor: answer.nextCursor ?? null}));
}

/** The pages and databases in a `notion-search` answer, best match first; other tools' results left out. */
export function parseNotionSearch(text: string): Result<NotionNode[], ApiError> {
	return parseJson(text, searchSchema).map((answer) => listedNodes(answer.results));
}

const propertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const propertiesSchema = z.record(z.string(), propertyValueSchema);

/** A page's properties as Notion gives them: text, numbers, lists of pages or people. */
export type NotionProperties = z.infer<typeof propertiesSchema>;

// What a property holds, written out; Notion leaves rollups and formulas as references it doesn't resolve.
export function propertyText(value: NotionProperties[string] | undefined): string {
	if (value === null || value === undefined) {
		return '';
	}
	const text = Array.isArray(value) ? value.join(', ') : String(value);
	return /^(rollupResult|formulaResult):\/\//.test(text) ? '' : text;
}

/** A page, a database row's properties beside its content. */
export type NotionPage = {
	kind: 'Page';
	id: string;
	title: string;
	url: string;
	path: string;
	// When it was last edited, as an ISO time; empty when Notion doesn't say.
	edited: string;
	// The properties as Notion gave them, the title and the page's address left out, and the
	// property the title is in: `title`, or a database's own name for it, such as "Company".
	properties: NotionProperties;
	titleProperty: string;
	content: string;
	// The pages and databases in its content, in order; a database Notion gives no title has none.
	children: NotionNode[];
	trail: NotionCrumb[];
};

/** A database's saved view, which lists its rows as it filters and sorts them. */
export type NotionViewSummary = {id: string; title: string};

/** One of a database's data sources: its rows' properties, by name and type. */
export type NotionDataSource = {id: string; name: string; schema: Record<string, string>};

export type NotionDatabase = {
	kind: 'Database';
	id: string;
	title: string;
	url: string;
	trail: NotionCrumb[];
	views: NotionViewSummary[];
	dataSources: NotionDataSource[];
};

export type NotionView = {kind: 'View'; id: string; title: string; dataSourceId: string};

/** A data source, and the database it belongs to. */
export type NotionDataSourceFetched = {kind: 'DataSource'; databaseId: string; dataSource: NotionDataSource};

export type NotionFetched = NotionPage | NotionDatabase | NotionView | NotionDataSourceFetched;

const fetchedSchema = z.object({
	metadata: z.object({type: z.string()}),
	title: z.string().optional(),
	url: z.string().optional(),
	path: z.string().optional(),
	icon: z.object({type: z.string(), emoji: z.string().optional()}).nullish(),
	page_last_edited_at: z.string().optional(),
	text: z.string(),
});

type Fetched = z.infer<typeof fetchedSchema>;

// What is between an element's tags in a fetched page, as Notion wrote it; null when it isn't there.
// The content runs to its last closing tag, since what is written in it can hold one too.
function between(text: string, tag: 'properties' | 'content' | 'ancestor-path'): string | null {
	const open = `<${tag}>\n`;
	const close = `\n</${tag}>`;
	const start = text.indexOf(open);
	const end = tag === 'content' ? text.lastIndexOf(close) : text.indexOf(close, start);
	if (start === -1 || end < start + open.length) {
		return null;
	}
	return text.slice(start + open.length, end);
}

// The pages and databases above, from `<ancestor-path>`, the top first. Notion lists them nearest
// first, a database's data source just before it; a database without a title of its own goes by
// its data source's name.
function trailOf(text: string): NotionCrumb[] {
	const crumbs: NotionCrumb[] = [];
	let dataSourceName = '';
	for (const match of (between(text, 'ancestor-path') ?? '').matchAll(/<(?:parent|ancestor-\d+)-(page|database|data-source)\s([^>]*)\/>/g)) {
		const attrs = attributes(match[2] ?? '');
		if (match[1] === 'data-source') {
			dataSourceName = attrs.name ?? '';
			continue;
		}
		const id = attrs.url ? idOfUrl(attrs.url) : null;
		if (id) {
			crumbs.push({id, title: attrs.title || (match[1] === 'database' ? dataSourceName : '') || 'Untitled'});
		}
	}
	return crumbs.reverse();
}

// The child pages and databases a page's content holds: `<page url="…">Title</page>`.
function childrenOf(content: string): NotionNode[] {
	return [...content.matchAll(/<(page|database)\s([^>]*)>([^<]*)<\/\1>/g)].flatMap((match) => {
		const url = attributes(match[2] ?? '').url ?? '';
		const id = idOfUrl(url);
		if (!id) {
			return [];
		}
		return [{id, kind: match[1] === 'page' ? 'Page' : 'Database', title: decode(match[3] ?? '').trim(), url: plainUrl(url), path: '', day: null} satisfies NotionNode];
	});
}

const dataSourceStateSchema = z.object({name: z.string().optional(), schema: z.record(z.string(), z.object({type: z.string()}))});

// The data sources a database or data source answer describes: `<data-source url="{{collection://…}}">`
// and the `<data-source-state>` JSON after it.
function dataSourcesOf(text: string): Result<NotionDataSource[], ApiError> {
	const found = [...text.matchAll(/<data-source url="([^"]+)">[\s\S]*?<data-source-state>\n([\s\S]*?)\n<\/data-source-state>/g)];
	return Result.all(
		found.map((match) => {
			const id = idOfRef(match[1] ?? '');
			return parseJson(match[2] ?? '', dataSourceStateSchema).andThen((state) =>
				id
					? Ok({id, name: state.name ?? '', schema: Object.fromEntries(Object.entries(state.schema).map(([name, property]) => [name, property.type]))})
					: Err(ApiErr.providerUnreachable(new Error('A data source without an id'))),
			);
		}),
	);
}

const viewStateSchema = z.object({name: z.string().optional(), dataSourceUrl: z.string().optional()});

// A database's saved views: `<view url="{{view://…}}">` and their JSON.
function viewsOf(text: string): NotionViewSummary[] {
	return [...text.matchAll(/<view url="([^"]+)">\n([\s\S]*?)\n<\/view>/g)].flatMap((match) => {
		const id = idOfRef(match[1] ?? '');
		const state = parseJson(match[2] ?? '', viewStateSchema);
		if (!id || state.isErr()) {
			return [];
		}
		return [{id: `view-${id}`, title: state.value.name || 'Untitled view'}];
	});
}

function pageOf(id: string, fetched: Fetched): Result<NotionPage, ApiError> {
	const json = between(fetched.text, 'properties');
	const parsed: Result<NotionProperties, ApiError> = json === null ? Ok({}) : parseJson(json, propertiesSchema);
	return parsed.map((all) => {
		// Notion puts an emoji icon before the title.
		const emoji = fetched.icon?.emoji;
		const title = (emoji && fetched.title?.startsWith(`${emoji} `) ? fetched.title.slice(emoji.length + 1) : fetched.title) || 'Untitled';
		// A database row's title is in a property of the database's own name, the one holding it.
		const titleProperty = Object.keys(all).find((name) => name !== 'title' && name !== 'url' && all[name] === title) ?? 'title';
		const properties = Object.fromEntries(Object.entries(all).filter(([name]) => name !== 'title' && name !== 'url' && name !== titleProperty));
		const content = between(fetched.text, 'content') ?? '';
		return {
			kind: 'Page',
			id,
			title,
			url: fetched.url ? plainUrl(fetched.url) : '',
			path: fetched.path ?? '',
			edited: fetched.page_last_edited_at ?? '',
			properties,
			titleProperty,
			content,
			children: childrenOf(content),
			trail: trailOf(fetched.text),
		};
	});
}

/**
 * What a `notion-fetch` answer describes: a page, a database, a database's saved view or one of
 * its data sources. Anything else is not found.
 */
export function parseNotionFetched(text: string): Result<NotionFetched, ApiError> {
	return parseJson(text, fetchedSchema).andThen((fetched): Result<NotionFetched, ApiError> => {
		const type = fetched.metadata.type;
		if (type === 'view') {
			const id = fetched.url ? idOfRef(fetched.url) : null;
			const dataSourceUrl = /"dataSourceUrl":"([^"]+)"/.exec(fetched.text)?.[1];
			const dataSourceId = dataSourceUrl ? idOfRef(dataSourceUrl) : null;
			if (!id || !dataSourceId) {
				return Err(ApiErr.notFound('view'));
			}
			return Ok({kind: 'View', id: `view-${id}`, title: fetched.title || 'Untitled view', dataSourceId});
		}

		const id = fetched.url ? idOfUrl(fetched.url) : null;
		if (!id) {
			return Err(ApiErr.notFound('page'));
		}
		if (type === 'page') {
			return pageOf(id, fetched);
		}
		if (type === 'database') {
			return dataSourcesOf(fetched.text).map((dataSources) => ({
				kind: 'Database',
				id,
				title: fetched.title || 'Untitled database',
				url: plainUrl(fetched.url ?? ''),
				trail: trailOf(fetched.text),
				views: viewsOf(fetched.text),
				dataSources,
			}));
		}
		if (type === 'data_source') {
			return dataSourcesOf(fetched.text).andThen((dataSources) => {
				const [dataSource] = dataSources;
				return dataSource ? Ok({kind: 'DataSource', databaseId: id, dataSource}) : Err(ApiErr.notFound('data source'));
			});
		}
		return Err(ApiErr.notFound('page'));
	});
}

const viewRowsSchema = z.object({results: z.array(z.record(z.string(), propertyValueSchema)), has_more: z.boolean().optional(), next_cursor: z.string().nullish()});

/**
 * The rows a view-mode `notion-query-data-sources` answer lists, as pages, their title in the
 * data source's `titleProperty`, and the cursor of the rows after them.
 */
export function parseNotionViewRows(text: string, titleProperty: string | null): Result<{nodes: NotionNode[]; nextCursor: string | null}, ApiError> {
	return parseJson(text, viewRowsSchema).map((answer) => ({
		nodes: answer.results.flatMap((row) => {
			const url = typeof row.url === 'string' ? row.url : '';
			const id = idOfUrl(url);
			if (!id) {
				return [];
			}
			const title = titleProperty ? propertyText(row[titleProperty]) : '';
			return [{id, kind: 'Page', title: title || 'Untitled', url: plainUrl(url), path: '', day: null} satisfies NotionNode];
		}),
		nextCursor: answer.has_more ? (answer.next_cursor ?? null) : null,
	}));
}

/** The page a `notion-create-pages` answer made: the first page address or id in it. */
export function parseNotionCreated(text: string): Result<string, ApiError> {
	const match = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i.exec(text);
	const id = match?.[1] ? plainId(match[1]) : null;
	if (!id) {
		return Err(ApiErr.providerUnreachable(new Error(`Notion did not say which page it made: ${text.slice(0, 200)}`)));
	}
	return Ok(id);
}
