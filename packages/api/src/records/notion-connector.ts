import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {callMcpToolFor} from '../connections/mcp/mcp-session';
import {
	dashedId,
	NOTION,
	parseNotionCreated,
	parseNotionFetched,
	parseNotionRecent,
	parseNotionRef,
	parseNotionSearch,
	parseNotionViewRows,
	propertyText,
	type NotionCrumb,
	type NotionDataSource,
	type NotionDatabase,
	type NotionFetched,
	type NotionNode,
	type NotionPage,
	type NotionRef,
	type NotionView,
} from '../connections/notion/notion-mcp';
import {notionValues, propertyLines, readPropertyLines, shapeOfType, shapeOfValue, type NotionValue, type PropertyShape} from '../connections/notion/notion-properties';
import type {Connector, Crumb, DataRecord, ListQuery, RecordPage, RecordTarget, RecordValues} from './connector';

/**
 * A Notion workspace, fetched live from Notion's MCP server as the person who signed in, as a tree
 * of pages, databases and their saved views. Notion has no list of every page, so the top of the
 * tree is their Recents, the pages and databases they opened lately, 50 to a page, and a search
 * finds the rest, its 50 best matches, everywhere or inside one page or database.
 *
 * Inside a page are the pages and databases in its content. Inside a database are its rows as its
 * saved view shows them, or its views when it has several, each listing the rows it filters to;
 * Notion's views page through every row on any plan. A row is a page, its properties written out
 * beside its content.
 *
 * A new page is a private draft at the top of the workspace, or goes inside the page or database
 * the agent is in. Editing a page changes its title, its properties and its content where they
 * changed; Notion refuses an edit that would drop a child page or database. Pages aren't deleted.
 */

const PAGE_SIZE = 50;

function callNotion(target: RecordTarget, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return callMcpToolFor(NOTION, target.connection, name, args);
}

function nodeRecord(node: NotionNode): DataRecord {
	return {
		id: node.id,
		values: {title: node.title, kind: node.kind, path: node.path},
		updatedAt: node.day ?? '',
		// A page's children are only known once it is opened.
		...(node.kind === 'Page' ? {} : {hasChildren: true}),
	};
}

function pathOf(trail: NotionCrumb[]): string {
	return trail.map((crumb) => crumb.title).join(' / ');
}

function fetchedRecord(fetched: NotionPage | NotionDatabase | NotionView): DataRecord {
	if (fetched.kind === 'Page') {
		return {
			id: fetched.id,
			values: {title: fetched.title, kind: 'Page', path: fetched.path, link: fetched.url, edited: fetched.edited, properties: propertyLines(fetched.properties), content: fetched.content},
			updatedAt: fetched.edited,
			hasChildren: fetched.children.length > 0,
		};
	}
	if (fetched.kind === 'Database') {
		return {id: fetched.id, values: {title: fetched.title, kind: 'Database', path: pathOf(fetched.trail), link: fetched.url}, updatedAt: '', hasChildren: true};
	}
	return {id: fetched.id, values: {title: fetched.title, kind: 'View'}, updatedAt: '', hasChildren: true};
}

// Only ever a page's, a database's or a view's id goes to Notion's fetch, which also takes
// addresses, `memory` and Notion's own documents.
function fetchRef(target: RecordTarget, ref: NotionRef): Promise<Result<NotionFetched, ApiError>> {
	return Do(async ($) => {
		const text = $(await callNotion(target, 'notion-fetch', {id: ref.kind === 'view' ? `view://${dashedId(ref.id)}` : ref.id}));
		return $(parseNotionFetched(text));
	});
}

function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

// A page, database or view by its record id; a data source, or anything else, is not found.
function fetchRecord(target: RecordTarget, recordId: string): Promise<Result<NotionPage | NotionDatabase | NotionView, ApiError>> {
	return Do(async ($) => {
		const ref = parseNotionRef(recordId);
		if (!ref) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		const fetched = $((await fetchRef(target, ref)).mapErr(notFoundAs(recordId)));
		if (fetched.kind === 'DataSource') {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		return fetched;
	});
}

function getPage(target: RecordTarget, recordId: string): Promise<Result<NotionPage, ApiError>> {
	return Do(async ($) => {
		const fetched = $(await fetchRecord(target, recordId));
		if (fetched.kind !== 'Page') {
			return $(Err(ApiErr.validationError(`Only pages are written to, not a ${fetched.kind.toLowerCase()}`)));
		}
		return fetched;
	});
}

// A view's data source, with the id of the database it is in.
function dataSourceOf(target: RecordTarget, view: NotionView): Promise<Result<{databaseId: string; dataSource: NotionDataSource}, ApiError>> {
	return Do(async ($) => {
		const text = $(await callNotion(target, 'notion-fetch', {id: `collection://${dashedId(view.dataSourceId)}`}));
		const fetched = $(parseNotionFetched(text));
		if (fetched.kind !== 'DataSource') {
			return $(Err(ApiErr.providerUnreachable(new Error('Notion answered a data source with something else'))));
		}
		return fetched;
	});
}

function titlePropertyOf(dataSource: NotionDataSource | undefined): string | null {
	return Object.entries(dataSource?.schema ?? {}).find(([, type]) => type === 'title')?.[0] ?? null;
}

function search(target: RecordTarget, query: string, within: Record<string, string> = {}): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const text = $(await callNotion(target, 'notion-search', {query, page_size: PAGE_SIZE, max_highlight_length: 0, ...within}));
		return {records: $(parseNotionSearch(text)).map(nodeRecord), nextPage: null};
	});
}

// A view's rows, 50 at a time, from the cursor a previous page gave. Where they are goes without
// saying: the list is opened in their database.
function viewRows(target: RecordTarget, viewId: string, dataSource: NotionDataSource | undefined, cursor: string | null): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const view = parseNotionRef(viewId);
		if (view?.kind !== 'view') {
			return $(Err(ApiErr.notFound('record', viewId)));
		}
		const data = {mode: 'view', view_url: `view://${dashedId(view.id)}`, page_size: PAGE_SIZE, ...(cursor ? {start_cursor: cursor} : {})};
		const text = $(await callNotion(target, 'notion-query-data-sources', {data}));
		const rows = $(parseNotionViewRows(text, titlePropertyOf(dataSource)));
		return {records: rows.nodes.map(nodeRecord), nextPage: rows.nextCursor};
	});
}

// A page's child pages and databases; a database Notion gives no title in the page is fetched for one.
async function childrenOf(target: RecordTarget, page: NotionPage): Promise<RecordPage> {
	const named = await Promise.all(
		page.children.map(async (child) => {
			if (child.title !== '') {
				return child;
			}
			const fetched = await fetchRef(target, {kind: 'node', id: child.id});
			const title = fetched.isOk() && fetched.value.kind === 'Database' ? fetched.value.title : `Untitled ${child.kind.toLowerCase()}`;
			return {...child, title};
		}),
	);
	return {records: named.map(nodeRecord), nextPage: null};
}

function withTrail(page: RecordPage, trail: NotionCrumb[]): RecordPage & {trail: Crumb[]} {
	return {...page, trail};
}

// What a list opened in a page, a database or a view shows, and where it is.
function listInside(target: RecordTarget, parent: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const fetched = $(await fetchRecord(target, parent));
		if (fetched.kind === 'Page') {
			const trail = [...fetched.trail, {id: fetched.id, title: fetched.title}];
			const page = query.search === null ? await childrenOf(target, fetched) : $(await search(target, query.search, {page_url: fetched.id}));
			return withTrail(page, trail);
		}

		if (fetched.kind === 'Database') {
			const trail = [...fetched.trail, {id: fetched.id, title: fetched.title}];
			const [dataSource] = fetched.dataSources;
			if (query.search !== null) {
				return withTrail($(await search(target, query.search, dataSource ? {data_source_url: `collection://${dashedId(dataSource.id)}`} : {})), trail);
			}
			const [only, ...others] = fetched.views;
			if (only && others.length === 0) {
				return withTrail($(await viewRows(target, only.id, dataSource, query.page)), trail);
			}
			const views = fetched.views.map((view): NotionNode => ({id: view.id, kind: 'View', title: view.title, url: '', path: '', day: null}));
			return withTrail({records: views.map(nodeRecord), nextPage: null}, trail);
		}

		const {databaseId, dataSource} = $(await dataSourceOf(target, fetched));
		const database = $(await fetchRef(target, {kind: 'node', id: databaseId}));
		const above = database.kind === 'Database' ? [...database.trail, {id: database.id, title: database.title}] : [];
		const trail = [...above, {id: fetched.id, title: fetched.title}];
		if (query.search !== null) {
			return withTrail($(await search(target, query.search, {data_source_url: `collection://${dashedId(dataSource.id)}`})), trail);
		}
		return withTrail($(await viewRows(target, fetched.id, dataSource, query.page)), trail);
	});
}

function list(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		if (query.parent !== null) {
			return $(await listInside(target, query.parent, query));
		}
		if (query.search !== null) {
			return $(await search(target, query.search));
		}
		const text = $(await callNotion(target, 'notion-list-recent-pages', {limit: PAGE_SIZE, ...(query.page ? {cursor: query.page} : {})}));
		const recent = $(parseNotionRecent(text));
		return {records: recent.nodes.map(nodeRecord), nextPage: recent.nextCursor};
	});
}

// The properties lines written, as Notion's page tools take them, for the properties `shapes` names.
function writtenProperties(text: string, shapes: Record<string, PropertyShape>, unchanged: (name: string, value: string) => boolean): Result<Record<string, NotionValue>, ApiError> {
	return Do<Record<string, NotionValue>, ApiError>(($) => {
		const written = $(readPropertyLines(text, Object.keys(shapes)));
		const values: Record<string, NotionValue> = {};
		for (const [name, value] of Object.entries(written)) {
			const shape = shapes[name];
			if (shape && !unchanged(name, value)) {
				Object.assign(values, $(notionValues(name, shape, value)));
			}
		}
		return values;
	});
}

type NewPages = {
	creation_mode?: 'draft';
	parent?: {type: 'page_id'; page_id: string} | {type: 'data_source_id'; data_source_id: string};
	pages: Array<{properties: Record<string, NotionValue>; content: string}>;
};

// Where a new page goes and what it is made with: a draft, a page inside a page, or a row of a
// database, its title in the database's title property and the properties written for it.
function placeNew(target: RecordTarget, values: RecordValues, parent: string | null): Promise<Result<NewPages, ApiError>> {
	return Do(async ($) => {
		const title = values.title ?? '';
		const content = values.content ?? '';
		const written = (values.properties ?? '').trim();
		const fetched = parent === null ? null : $(await fetchRecord(target, parent));
		if (fetched === null || fetched.kind === 'Page') {
			if (written !== '') {
				return $(Err(ApiErr.validationError('Properties are only for rows of a database; open the database and add the page there')));
			}
			const pages = [{properties: {title}, content}];
			return fetched === null ? {creation_mode: 'draft', pages} : {parent: {type: 'page_id', page_id: dashedId(fetched.id)}, pages};
		}

		const dataSource = fetched.kind === 'Database' ? fetched.dataSources[0] : $(await dataSourceOf(target, fetched)).dataSource;
		if (!dataSource) {
			return $(Err(ApiErr.validationError('This database has no rows to add to')));
		}
		const shapes = Object.fromEntries(
			Object.entries(dataSource.schema).flatMap(([name, type]) => {
				const shape = shapeOfType(type);
				return shape ? [[name, shape] as const] : [];
			}),
		);
		const properties = $(writtenProperties(written, shapes, () => false));
		return {parent: {type: 'data_source_id', data_source_id: dashedId(dataSource.id)}, pages: [{properties: {...properties, [titlePropertyOf(dataSource) ?? 'title']: title}, content}]};
	});
}

export const notionConnector: Connector = {
	list,
	get: (target, recordId) =>
		Do(async ($) => {
			return fetchedRecord($(await fetchRecord(target, recordId)));
		}),
	create: (target, values, parent) =>
		Do(async ($) => {
			const args = $(await placeNew(target, values, parent));
			const text = $(await callNotion(target, 'notion-create-pages', args));
			return fetchedRecord($(await getPage(target, $(parseNotionCreated(text)))));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const page = $(await getPage(target, recordId));
			const shapes = Object.fromEntries(Object.entries(page.properties).map(([name, value]) => [name, shapeOfValue(value)]));
			const properties = $(writtenProperties(values.properties ?? '', shapes, (name, value) => value === propertyText(page.properties[name])));
			const title = values.title ?? page.title;
			const changed = title === page.title ? properties : {...properties, [page.titleProperty]: title};
			if (Object.keys(changed).length > 0) {
				$(await callNotion(target, 'notion-update-page', {page_id: page.id, command: 'update_properties', properties: changed}));
			}
			const content = values.content ?? page.content;
			if (content !== page.content) {
				$(await callNotion(target, 'notion-update-page', {page_id: page.id, command: 'replace_content', new_str: content}));
			}
			return fetchedRecord($(await getPage(target, page.id)));
		}),
	remove: () => Promise.resolve(Err(ApiErr.validationError('Notion pages are not deleted here'))),
};
