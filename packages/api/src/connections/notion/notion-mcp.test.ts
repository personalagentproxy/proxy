import {describe, expect, test} from 'bun:test';

import {dashedId, NOTION, parseNotionCreated, parseNotionFetched, parseNotionRecent, parseNotionRef, parseNotionSearch, parseNotionViewRows} from './notion-mcp';

const PAGE = '3e4955a63d7e8069a438e7961ef050ef';
const ROW = '3e9955a63d7e81a0b356e2f6608e90e1';
const DATABASE = '3e4955a63d7e80fbb098de47972ece1a';
const DATA_SOURCE = '3e4955a6-3d7e-8086-b78e-000b4f38d6a4';
const VIEW = '3e4955a6-3d7e-81d5-824b-000c78cacd54';
const url = (id: string) => `https://app.notion.com/p/${id}`;

// What notion-fetch answers, its text as Notion writes it for models.
function fetched(args: {type?: string; url: string; title: string; icon?: object | null; path?: string; edited?: string; body: string}): string {
	return JSON.stringify({
		metadata: {type: args.type ?? 'page'},
		title: args.title,
		url: `${args.url}?pvs=204`,
		cover: null,
		icon: args.icon ?? null,
		...(args.path ? {path: args.path} : {}),
		...(args.edited ? {page_last_edited_at: args.edited} : {}),
		text: `Here is the result of "fetch" for the Page with URL ${args.url} as of 2026-09-28T22:43:27.600Z:\n<page url="${args.url}">\n${args.body}\n</page>`,
	});
}

const ROW_ANCESTORS = `<ancestor-path>\n<parent-data-source url="collection://${DATA_SOURCE}" name="Companies"/>\n<ancestor-2-database url="${url(DATABASE)}" title=""/>\n<ancestor-3-page url="${url(PAGE)}" title="Outreach &amp; sales"/>\n</ancestor-path>`;

const DATA_SOURCE_STATE = JSON.stringify({name: 'Companies', schema: {Company: {name: 'Company', type: 'title'}, Status: {name: 'Status', type: 'status'}, Size: {name: 'Size', type: 'number'}}});

describe('parseNotionRef', () => {
	test('takes a page or database id, with or without dashes, or a view, and nothing else', () => {
		expect(parseNotionRef('3E4955A6-3d7e-8069-a438-e7961ef050ef')).toEqual({kind: 'node', id: PAGE});
		expect(parseNotionRef(`view-${VIEW}`)).toEqual({kind: 'view', id: VIEW.replace(/-/g, '')});
		expect(parseNotionRef('memory')).toBeNull();
		expect(parseNotionRef(url(PAGE))).toBeNull();
		expect(parseNotionRef(`collection://${DATA_SOURCE}`)).toBeNull();
		expect(dashedId(PAGE)).toBe('3e4955a6-3d7e-8069-a438-e7961ef050ef');
	});
});

describe('parseNotionRecent', () => {
	test('reads pages and databases by the id in their address, and the next cursor', () => {
		const text = JSON.stringify({
			results: [
				{type: 'page', url: `${url(PAGE)}?pvs=204`, title: 'Outreach', icon: '🦁'},
				{type: 'database', url: `${url(DATABASE)}?pvs=204`, title: 'Companies'},
				{type: 'page', url: `${url(ROW)}?pvs=204`, title: ''},
			],
			nextCursor: 'offset:3',
		});

		expect(parseNotionRecent(text).unwrap()).toEqual({
			nodes: [
				{id: PAGE, kind: 'Page', title: 'Outreach', url: url(PAGE), path: '', day: null},
				{id: DATABASE, kind: 'Database', title: 'Companies', url: url(DATABASE), path: '', day: null},
				{id: ROW, kind: 'Page', title: 'Untitled', url: url(ROW), path: '', day: null},
			],
			nextCursor: 'offset:3',
		});
	});
});

describe('parseNotionSearch', () => {
	test("reads what it found, where it is and the day it was edited, and leaves other tools' results out", () => {
		const text = JSON.stringify({
			results: [
				{id: '3e9955a6-3d7e-81a0-b356-e2f6608e90e1', title: 'Acme GmbH', url: `${url(ROW)}?pvs=204`, type: 'page', timestamp: '9 days ago (2026-09-28)', path: 'Outreach / Companies'},
				{id: 'C0123', title: 'Message in #sales', url: 'https://acme.slack.com/archives/C0123', type: 'slack'},
			],
			type: 'ai_search',
		});

		expect(parseNotionSearch(text).unwrap()).toEqual([{id: ROW, kind: 'Page', title: 'Acme GmbH', url: url(ROW), path: 'Outreach / Companies', day: '2026-09-28'}]);
		expect(parseNotionSearch('Something else').isErr()).toBe(true);
	});
});

describe('parseNotionFetched', () => {
	test('reads a page: its title without the emoji Notion puts first, its content as written, and the pages and databases in it', () => {
		const text = fetched({
			url: url(PAGE),
			title: '🦁 Outreach',
			icon: {type: 'emoji', emoji: '🦁'},
			edited: '2026-09-24T00:38:13.331Z',
			body: `<ancestor-path></ancestor-path>\n<properties>\n{"title":"Outreach"}\n</properties>\n<content>\n<database url="${url(DATABASE)}" inline="false" data-source-url="collection://${DATA_SOURCE}"></database>\n<page url="${url(ROW)}">Notes &amp; ideas</page>\n> **How we keep this**\n</content>`,
		});

		expect(parseNotionFetched(text).unwrap()).toEqual({
			kind: 'Page',
			id: PAGE,
			title: 'Outreach',
			url: url(PAGE),
			path: '',
			edited: '2026-09-24T00:38:13.331Z',
			properties: {},
			titleProperty: 'title',
			content: `<database url="${url(DATABASE)}" inline="false" data-source-url="collection://${DATA_SOURCE}"></database>\n<page url="${url(ROW)}">Notes &amp; ideas</page>\n> **How we keep this**`,
			children: [
				{id: DATABASE, kind: 'Database', title: '', url: url(DATABASE), path: '', day: null},
				{id: ROW, kind: 'Page', title: 'Notes & ideas', url: url(ROW), path: '', day: null},
			],
			trail: [],
		});
	});

	test("reads a database row: the property holding its title, the others, and what it's in, a database going by its data source's name", () => {
		const properties = {Company: 'Acme GmbH', Status: 'Contacted', Size: 100, Contacts: [url(PAGE)], url: url(ROW)};
		const text = fetched({
			url: url(ROW),
			title: 'Acme GmbH',
			path: 'Outreach / Companies',
			body: `${ROW_ANCESTORS}\n<properties>\n${JSON.stringify(properties)}\n</properties>\n<blank-page>This page is blank and has no content.</blank-page>`,
		});

		const page = parseNotionFetched(text).unwrap();
		expect(page).toMatchObject({kind: 'Page', titleProperty: 'Company', properties: {Status: 'Contacted', Size: 100, Contacts: [url(PAGE)]}, content: '', children: []});
		expect(page.kind === 'Page' && page.trail).toEqual([
			{id: PAGE, title: 'Outreach & sales'},
			{id: DATABASE, title: 'Companies'},
		]);
	});

	test('reads a database: its views and its data sources, the property types they have', () => {
		const text = JSON.stringify({
			metadata: {type: 'database'},
			title: 'Companies',
			url: `${url(DATABASE)}?pvs=204`,
			text: `<database url="{{${url(DATABASE)}}}" inline="false">\n<ancestor-path>\n<parent-page url="${url(PAGE)}" title="Outreach"/>\n</ancestor-path>\n<data-sources>\n<data-source url="{{collection://${DATA_SOURCE}}}">\n<data-source-state>\n${DATA_SOURCE_STATE}\n</data-source-state>\n</data-source>\n</data-sources>\n<views>\n<view url="{{view://${VIEW}}}">\n{"name":"Insolvencies","dataSourceUrl":"{{collection://${DATA_SOURCE}}}","type":"table"}\n</view>\n</views>\n</database>`,
		});

		expect(parseNotionFetched(text).unwrap()).toEqual({
			kind: 'Database',
			id: DATABASE,
			title: 'Companies',
			url: url(DATABASE),
			trail: [{id: PAGE, title: 'Outreach'}],
			views: [{id: `view-${VIEW.replace(/-/g, '')}`, title: 'Insolvencies'}],
			dataSources: [{id: DATA_SOURCE.replace(/-/g, ''), name: 'Companies', schema: {Company: 'title', Status: 'status', Size: 'number'}}],
		});
	});

	test('reads a view and the data source it shows, and a data source and the database it is in', () => {
		const view = JSON.stringify({
			metadata: {type: 'view'},
			title: 'Insolvencies',
			url: `view://${VIEW}`,
			text: `<view url="{{view://${VIEW}}}">\n{"dataSourceUrl":"{{collection://${DATA_SOURCE}}}","name":"Insolvencies"}\n</view>`,
		});
		const dataSource = JSON.stringify({
			metadata: {type: 'data_source'},
			title: 'Companies',
			url: `${url(DATABASE)}?pvs=204`,
			text: `<data-source url="{{collection://${DATA_SOURCE}}}">\n<data-source-state>\n${DATA_SOURCE_STATE}\n</data-source-state>\n</data-source>`,
		});

		expect(parseNotionFetched(view).unwrap()).toEqual({kind: 'View', id: `view-${VIEW.replace(/-/g, '')}`, title: 'Insolvencies', dataSourceId: DATA_SOURCE.replace(/-/g, '')});
		expect(parseNotionFetched(dataSource).unwrap()).toMatchObject({kind: 'DataSource', databaseId: DATABASE, dataSource: {name: 'Companies'}});
	});

	test('anything else is not found', () => {
		expect(parseNotionFetched(JSON.stringify({metadata: {type: 'skill'}, url: url(PAGE), text: ''})).unwrapErr().kind).toBe('not_found');
	});
});

describe('parseNotionViewRows', () => {
	test("reads the rows by their address, titled by the data source's title property, and the cursor after them", () => {
		const text = JSON.stringify({
			results: [
				{url: url(ROW), Company: 'Acme GmbH', Status: 'Contacted'},
				{url: url(PAGE), Company: ''},
			],
			has_more: true,
			next_cursor: 's:cursor',
		});

		expect(parseNotionViewRows(text, 'Company').unwrap()).toEqual({
			nodes: [
				{id: ROW, kind: 'Page', title: 'Acme GmbH', url: url(ROW), path: '', day: null},
				{id: PAGE, kind: 'Page', title: 'Untitled', url: url(PAGE), path: '', day: null},
			],
			nextCursor: 's:cursor',
		});
		expect(parseNotionViewRows(JSON.stringify({results: [], has_more: false, next_cursor: 's:x'}), 'Company').unwrap().nextCursor).toBeNull();
	});
});

describe('parseNotionCreated', () => {
	test('reads the id of the page made', () => {
		expect(parseNotionCreated(JSON.stringify({pages: [{id: '3e4955a6-3d7e-8069-a438-e7961ef050ef', url: url(PAGE)}]})).unwrap()).toBe(PAGE);
		expect(parseNotionCreated('Nothing made').isErr()).toBe(true);
	});
});

describe("Notion's tool errors", () => {
	test('a page it cannot find is not found, and an edit it turns down says why', () => {
		const notFound = JSON.stringify({name: 'APIResponseError', code: 'object_not_found', status: 404, message: 'Could not find page'});
		const invalid = JSON.stringify({name: 'APIResponseError', code: 'validation_error', status: 400, message: 'Would delete 1 child page'});

		expect(NOTION.toolError?.(notFound)?.kind).toBe('not_found');
		expect(NOTION.toolError?.(invalid)).toMatchObject({kind: 'validation_error', message: 'Notion turned it down: Would delete 1 child page'});
		expect(NOTION.toolError?.('{"code":"rate_limited"}')).toBeNull();
		expect(NOTION.toolError?.('Something broke')).toBeNull();
	});
});
