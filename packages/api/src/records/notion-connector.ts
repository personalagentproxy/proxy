import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {callMcpToolFor} from '../connections/mcp/mcp-session';
import {NOTION, notionPageId, parseNotionCreated, parseNotionPage, parseNotionRecent, parseNotionSearch, type NotionPage, type NotionPageRow} from '../connections/notion/notion-mcp';
import type {Connector, DataRecord, RecordTarget} from './connector';

/**
 * A Notion workspace's pages, fetched live from Notion's MCP server as the person who signed in.
 * Notion has no list of every page, so the list is their Recents, the pages they opened lately,
 * 50 to a page, and a search finds the rest, its 50 best matches. Opening a page reads it as
 * Notion-flavored Markdown, with a database row's properties beside it. A new page is a private
 * draft at the top of the workspace; editing replaces the title and content where they changed,
 * and Notion refuses an edit that would drop a child page or database. Pages aren't deleted.
 */

const PAGE_SIZE = 50;

function rowRecord(page: NotionPageRow): DataRecord {
	return {id: page.id, values: {title: page.title, path: page.path}, updatedAt: page.day ?? ''};
}

function pageRecord(page: NotionPage): DataRecord {
	return {
		id: page.id,
		values: {title: page.title, path: page.path, link: page.url, edited: page.edited, properties: page.properties, content: page.content},
		updatedAt: page.edited,
	};
}

function callNotion(target: RecordTarget, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return callMcpToolFor(NOTION, target.connection, name, args);
}

// Only ever a page's id goes to Notion's fetch, which also takes addresses, databases and Notion's
// own documents.
function getPage(target: RecordTarget, recordId: string): Promise<Result<NotionPage, ApiError>> {
	return Do(async ($) => {
		const id = notionPageId(recordId);
		if (!id) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		const text = await callNotion(target, 'notion-fetch', {id});
		if (text.isErr() && text.error.kind === 'not_found') {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		const page = parseNotionPage($(text));
		if (page.isErr() && page.error.kind === 'not_found') {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		return $(page);
	});
}

export const notionConnector: Connector = {
	list: (target, query) =>
		Do(async ($) => {
			if (query.search !== null) {
				const text = $(await callNotion(target, 'notion-search', {query: query.search, page_size: PAGE_SIZE, max_highlight_length: 0}));
				return {records: $(parseNotionSearch(text)).map(rowRecord), nextPage: null};
			}
			const text = $(await callNotion(target, 'notion-list-recent-pages', {limit: PAGE_SIZE, ...(query.page ? {cursor: query.page} : {})}));
			const recent = $(parseNotionRecent(text));
			return {records: recent.pages.map(rowRecord), nextPage: recent.nextCursor};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			return pageRecord($(await getPage(target, recordId)));
		}),
	create: (target, values) =>
		Do(async ($) => {
			const text = $(await callNotion(target, 'notion-create-pages', {creation_mode: 'draft', pages: [{properties: {title: values.title ?? ''}, content: values.content ?? ''}]}));
			return pageRecord($(await getPage(target, $(parseNotionCreated(text)))));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const page = $(await getPage(target, recordId));
			const title = values.title ?? page.title;
			const content = values.content ?? page.content;
			if (title !== page.title) {
				$(await callNotion(target, 'notion-update-page', {page_id: page.id, command: 'update_properties', properties: {title}}));
			}
			if (content !== page.content) {
				$(await callNotion(target, 'notion-update-page', {page_id: page.id, command: 'replace_content', new_str: content}));
			}
			return pageRecord($(await getPage(target, page.id)));
		}),
	remove: () => Promise.resolve(Err(ApiErr.validationError('Notion pages are not deleted here'))),
};
