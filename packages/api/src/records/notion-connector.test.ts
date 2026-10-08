import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

// Notion's tools by name, answering as its MCP server does.
type Call = {name: string; args: Record<string, unknown>};
const tools = {calls: [] as Call[], answer: (_call: Call): Result<string, ApiError> => Ok('')};

mock.module('../connections/mcp/mcp-session', () => ({
	callMcpToolFor: async (_server: unknown, _connection: unknown, name: string, args: Record<string, unknown>) => {
		tools.calls.push({name, args});
		return tools.answer({name, args});
	},
}));

function pages(): Collection {
	const integration = findIntegration('notion');
	const found = integration && findCollection(integration, 'pages');
	if (!found) {
		throw new Error('No pages collection');
	}
	return found;
}

const target = {
	connection: {id: 'notion-1', integrationId: 'notion', account: 'alex@example.com · Acme', createdAt: new Date(), defaults: [], credential: 'v1.encrypted'},
	collection: pages(),
};

const PAGE = '3e4955a63d7e8069a438e7961ef050ef';
const ROW = '3e9955a63d7e81a0b356e2f6608e90e1';
const DATABASE = '3e4955a63d7e80fbb098de47972ece1a';
const DATA_SOURCE = '3e4955a6-3d7e-8086-b78e-000b4f38d6a4';
const VIEW = '3e4955a6-3d7e-81d5-824b-000c78cacd54';
const VIEW_ID = `view-${VIEW.replace(/-/g, '')}`;
const url = (id: string) => `https://app.notion.com/p/${id}`;
const query = (changes: object = {}) => ({search: null, page: null, filter: null, parent: null, ...changes});

function fetchedPage(id: string, title: string, args: {content?: string; properties?: object; ancestors?: string} = {}): string {
	const properties = JSON.stringify(args.properties ?? {title});
	const content = args.content === undefined ? '<blank-page>This page is blank and has no content.</blank-page>' : `<content>\n${args.content}\n</content>`;
	return JSON.stringify({
		metadata: {type: 'page'},
		title,
		url: `${url(id)}?pvs=204`,
		page_last_edited_at: '2026-09-24T00:38:13.331Z',
		text: `<page url="${url(id)}">\n<ancestor-path>\n${args.ancestors ?? ''}\n</ancestor-path>\n<properties>\n${properties}\n</properties>\n${content}\n</page>`,
	});
}

const DATA_SOURCE_STATE = JSON.stringify({name: 'Companies', schema: {Company: {type: 'title'}, Status: {type: 'status'}, Size: {type: 'number'}, Owner: {type: 'formula'}}});

function fetchedDatabase(views: string[]): string {
	const viewTags = views.map((view, index) => `<view url="{{view://${view}}}">\n{"name":"View ${index + 1}","dataSourceUrl":"{{collection://${DATA_SOURCE}}}"}\n</view>`).join('\n');
	return JSON.stringify({
		metadata: {type: 'database'},
		title: 'Companies',
		url: url(DATABASE),
		text: `<database url="{{${url(DATABASE)}}}">\n<ancestor-path>\n<parent-page url="${url(PAGE)}" title="Outreach"/>\n</ancestor-path>\n<data-source url="{{collection://${DATA_SOURCE}}}">\n<data-source-state>\n${DATA_SOURCE_STATE}\n</data-source-state>\n</data-source>\n<views>\n${viewTags}\n</views>\n</database>`,
	});
}

const fetchedView = JSON.stringify({
	metadata: {type: 'view'},
	title: 'Insolvencies',
	url: `view://${VIEW}`,
	text: `<view url="{{view://${VIEW}}}">\n{"dataSourceUrl":"{{collection://${DATA_SOURCE}}}"}\n</view>`,
});
const fetchedDataSource = JSON.stringify({
	metadata: {type: 'data_source'},
	title: 'Companies',
	url: url(DATABASE),
	text: `<data-source url="{{collection://${DATA_SOURCE}}}">\n<data-source-state>\n${DATA_SOURCE_STATE}\n</data-source-state>\n</data-source>`,
});
const viewRows = JSON.stringify({results: [{url: url(ROW), Company: 'Acme GmbH', Status: 'Contacted'}], has_more: true, next_cursor: 's:next'});

const ROW_PROPERTIES = {Company: 'Acme GmbH', Status: 'Contacted', Size: 100, Notes: ''};

// A workspace of a page holding a database of companies, its one view listing them.
function answer({name, args}: Call): Result<string, ApiError> {
	if (name === 'notion-fetch' && args.id === PAGE) {
		return Ok(fetchedPage(PAGE, 'Outreach', {content: `<database url="${url(DATABASE)}" inline="false"></database>\n<page url="${url(ROW)}">Plan</page>`}));
	}
	if (name === 'notion-fetch' && args.id === DATABASE) {
		return Ok(fetchedDatabase([VIEW]));
	}
	if (name === 'notion-fetch' && args.id === ROW) {
		return Ok(fetchedPage(ROW, 'Acme GmbH', {properties: {...ROW_PROPERTIES, url: url(ROW)}, ancestors: `<parent-data-source url="collection://${DATA_SOURCE}" name="Companies"/>`}));
	}
	if (name === 'notion-fetch' && args.id === `view://${VIEW}`) {
		return Ok(fetchedView);
	}
	if (name === 'notion-fetch' && args.id === `collection://${DATA_SOURCE}`) {
		return Ok(fetchedDataSource);
	}
	if (name === 'notion-fetch') {
		return Err(ApiErr.notFound('page'));
	}
	if (name === 'notion-query-data-sources') {
		return Ok(viewRows);
	}
	if (name === 'notion-create-pages') {
		return Ok(JSON.stringify({pages: [{id: '3e9955a6-3d7e-81a0-b356-e2f6608e90e1', url: url(ROW)}]}));
	}
	return Ok('{"results":[]}');
}

beforeEach(() => {
	tools.calls = [];
	tools.answer = answer;
});

describe('notionConnector.list', () => {
	test("at the top, the person's recent pages and databases, 50 to a page, a database opening into its rows", async () => {
		tools.answer = () =>
			Ok(
				JSON.stringify({
					results: [
						{type: 'page', url: url(PAGE), title: 'Outreach'},
						{type: 'database', url: url(DATABASE), title: 'Companies'},
					],
					nextCursor: 'offset:50',
				}),
			);
		const {notionConnector} = await import('./notion-connector');
		const page = (await notionConnector.list(target, query({page: 'offset:0'}))).unwrap();

		expect(tools.calls).toEqual([{name: 'notion-list-recent-pages', args: {limit: 50, cursor: 'offset:0'}}]);
		expect(page).toEqual({
			records: [
				{id: PAGE, values: {title: 'Outreach', kind: 'Page', path: ''}, updatedAt: ''},
				{id: DATABASE, values: {title: 'Companies', kind: 'Database', path: ''}, updatedAt: '', hasChildren: true},
			],
			nextPage: 'offset:50',
		});
	});

	test('inside a page, the pages and databases in it, a database without a title fetched for one', async () => {
		const {notionConnector} = await import('./notion-connector');
		const page = (await notionConnector.list(target, query({parent: PAGE}))).unwrap();

		expect(page.records.map((record) => [record.id, record.values.title, record.values.kind])).toEqual([
			[DATABASE, 'Companies', 'Database'],
			[ROW, 'Plan', 'Page'],
		]);
		expect(page.trail).toEqual([{id: PAGE, title: 'Outreach'}]);
	});

	test("inside a database with one view, that view's rows, from the cursor", async () => {
		const {notionConnector} = await import('./notion-connector');
		const page = (await notionConnector.list(target, query({parent: DATABASE, page: 's:first'}))).unwrap();

		expect(tools.calls.at(-1)).toEqual({name: 'notion-query-data-sources', args: {data: {mode: 'view', view_url: `view://${VIEW}`, page_size: 50, start_cursor: 's:first'}}});
		expect(page.records).toEqual([{id: ROW, values: {title: 'Acme GmbH', kind: 'Page', path: ''}, updatedAt: ''}]);
		expect(page.nextPage).toBe('s:next');
		expect(page.trail).toEqual([
			{id: PAGE, title: 'Outreach'},
			{id: DATABASE, title: 'Companies'},
		]);
	});

	test('inside a database with several views, the views, each opening into its rows', async () => {
		const other = '3e4955a6-3d7e-819c-9fa9-000ca05d402d';
		tools.answer = (call) => (call.name === 'notion-fetch' && call.args.id === DATABASE ? Ok(fetchedDatabase([VIEW, other])) : answer(call));
		const {notionConnector} = await import('./notion-connector');
		const views = (await notionConnector.list(target, query({parent: DATABASE}))).unwrap();

		expect(views.records.map((record) => [record.id, record.values.kind, record.hasChildren])).toEqual([
			[VIEW_ID, 'View', true],
			[`view-${other.replace(/-/g, '')}`, 'View', true],
		]);

		const rows = (await notionConnector.list(target, query({parent: VIEW_ID}))).unwrap();
		expect(rows.records.map((record) => record.values.title)).toEqual(['Acme GmbH']);
		expect(rows.trail).toEqual([
			{id: PAGE, title: 'Outreach'},
			{id: DATABASE, title: 'Companies'},
			{id: VIEW_ID, title: 'Insolvencies'},
		]);
	});

	test('a search inside a page or database looks only there', async () => {
		const {notionConnector} = await import('./notion-connector');
		await notionConnector.list(target, query({parent: PAGE, search: 'plan'}));
		await notionConnector.list(target, query({parent: DATABASE, search: 'acme'}));

		expect(tools.calls.filter((call) => call.name === 'notion-search').map((call) => call.args)).toEqual([
			{query: 'plan', page_size: 50, max_highlight_length: 0, page_url: PAGE},
			{query: 'acme', page_size: 50, max_highlight_length: 0, data_source_url: `collection://${DATA_SOURCE}`},
		]);
	});
});

describe('notionConnector.get', () => {
	test('opens a database row, its title property left out of the properties it lists', async () => {
		const {notionConnector} = await import('./notion-connector');
		const record = (await notionConnector.get(target, ROW)).unwrap();

		expect(record.values).toEqual({title: 'Acme GmbH', kind: 'Page', path: '', link: url(ROW), edited: '2026-09-24T00:38:13.331Z', properties: 'Status: Contacted\nSize: 100', content: ''});
		expect(record.hasChildren).toBe(false);
	});

	test('opens a database and a view, which hold rows', async () => {
		const {notionConnector} = await import('./notion-connector');
		expect((await notionConnector.get(target, DATABASE)).unwrap()).toMatchObject({values: {title: 'Companies', kind: 'Database', path: 'Outreach'}, hasChildren: true});
		expect((await notionConnector.get(target, VIEW_ID)).unwrap()).toMatchObject({values: {title: 'Insolvencies', kind: 'View'}, hasChildren: true});
	});

	test("only a page's, database's or view's id goes to Notion; one it can't find is not found", async () => {
		const {notionConnector} = await import('./notion-connector');
		expect((await notionConnector.get(target, 'memory')).unwrapErr()).toMatchObject({kind: 'not_found', id: 'memory'});
		expect(tools.calls).toEqual([]);
		expect((await notionConnector.get(target, '00000000000000000000000000000000')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
	});
});

describe('notionConnector writes', () => {
	test('a new page is a private draft at the top, or goes inside the page it is made in', async () => {
		const {notionConnector} = await import('./notion-connector');
		await notionConnector.create(target, {title: 'Plan', properties: '', content: '# Plan'}, null);
		await notionConnector.create(target, {title: 'Plan', properties: '', content: '# Plan'}, PAGE);

		expect(tools.calls.filter((call) => call.name === 'notion-create-pages').map((call) => call.args)).toEqual([
			{creation_mode: 'draft', pages: [{properties: {title: 'Plan'}, content: '# Plan'}]},
			{parent: {type: 'page_id', page_id: '3e4955a6-3d7e-8069-a438-e7961ef050ef'}, pages: [{properties: {title: 'Plan'}, content: '# Plan'}]},
		]);
		expect((await notionConnector.create(target, {title: 'Plan', properties: 'Status: New', content: ''}, PAGE)).unwrapErr().kind).toBe('validation_error');
	});

	test("a page made in a database or its view is a row, its title in the database's title property", async () => {
		const {notionConnector} = await import('./notion-connector');
		await notionConnector.create(target, {title: 'Globex', properties: 'Status: New\nSize: 12', content: ''}, DATABASE);
		await notionConnector.create(target, {title: 'Initech', properties: '', content: ''}, VIEW_ID);

		expect(tools.calls.filter((call) => call.name === 'notion-create-pages').map((call) => call.args)).toEqual([
			{parent: {type: 'data_source_id', data_source_id: DATA_SOURCE}, pages: [{properties: {Status: 'New', Size: 12, Company: 'Globex'}, content: ''}]},
			{parent: {type: 'data_source_id', data_source_id: DATA_SOURCE}, pages: [{properties: {Company: 'Initech'}, content: ''}]},
		]);
		expect((await notionConnector.create(target, {title: 'X', properties: 'Owner: Sam', content: ''}, DATABASE)).unwrapErr().kind).toBe('validation_error');
	});

	test("an edit sends only what changed: the title in the row's title property, properties written differently, the content", async () => {
		const {notionConnector} = await import('./notion-connector');
		await notionConnector.update(target, ROW, {title: 'Acme AG', properties: 'Status: Meeting\nSize: 100\nNotes: Call back', content: 'Met on Monday'});

		expect(tools.calls.filter((call) => call.name === 'notion-update-page').map((call) => call.args)).toEqual([
			{page_id: ROW, command: 'update_properties', properties: {Status: 'Meeting', Notes: 'Call back', Company: 'Acme AG'}},
			{page_id: ROW, command: 'replace_content', new_str: 'Met on Monday'},
		]);

		tools.calls = [];
		await notionConnector.update(target, ROW, {title: 'Acme GmbH', properties: 'Status: Contacted\nSize: 100', content: ''});
		expect(tools.calls.filter((call) => call.name === 'notion-update-page')).toEqual([]);
	});

	test('databases and views are not written to, and pages are not deleted', async () => {
		const {notionConnector} = await import('./notion-connector');
		expect((await notionConnector.update(target, DATABASE, {title: 'X', properties: '', content: ''})).unwrapErr().kind).toBe('validation_error');
		expect((await notionConnector.remove(target, PAGE)).isErr()).toBe(true);
	});
});
