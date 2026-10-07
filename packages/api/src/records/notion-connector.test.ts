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
const URL_OF = (id: string) => `https://app.notion.com/p/${id}`;

function fetchedPage(id: string, title: string, content: string): string {
	return JSON.stringify({
		metadata: {type: 'page'},
		title,
		url: `${URL_OF(id)}?pvs=204`,
		page_last_edited_at: '2026-09-24T00:38:13.331Z',
		text: `<page url="${URL_OF(id)}">\n<properties>\n{"title":"${title}"}\n</properties>\n<content>\n${content}\n</content>\n</page>`,
	});
}

beforeEach(() => {
	tools.calls = [];
	tools.answer = ({name}) => {
		if (name === 'notion-fetch') {
			return Ok(fetchedPage(PAGE, 'Plan', '# Plan\n- one'));
		}
		return Ok('{}');
	};
});

describe('notionConnector.list', () => {
	test("lists the person's recent pages, 50 to a page, going on from the cursor", async () => {
		tools.answer = () => Ok(JSON.stringify({results: [{type: 'page', url: `${URL_OF(PAGE)}?pvs=204`, title: 'Plan'}], nextCursor: 'offset:50'}));
		const {notionConnector} = await import('./notion-connector');
		const page = (await notionConnector.list(target, {search: null, page: 'offset:0', filter: null})).unwrap();

		expect(tools.calls).toEqual([{name: 'notion-list-recent-pages', args: {limit: 50, cursor: 'offset:0'}}]);
		expect(page).toEqual({records: [{id: PAGE, values: {title: 'Plan', path: ''}, updatedAt: ''}], nextPage: 'offset:50'});
	});

	test("searches with Notion's search, one page of the best matches", async () => {
		tools.answer = () => Ok(JSON.stringify({results: [{id: PAGE, type: 'page', url: URL_OF(PAGE), title: 'Plan', path: 'Team', timestamp: '2 days ago (2026-10-05)'}]}));
		const {notionConnector} = await import('./notion-connector');
		const page = (await notionConnector.list(target, {search: 'plan', page: null, filter: null})).unwrap();

		expect(tools.calls).toEqual([{name: 'notion-search', args: {query: 'plan', page_size: 50, max_highlight_length: 0}}]);
		expect(page).toEqual({records: [{id: PAGE, values: {title: 'Plan', path: 'Team'}, updatedAt: '2026-10-05'}], nextPage: null});
	});
});

describe('notionConnector.get', () => {
	test('opens a page by its id', async () => {
		const {notionConnector} = await import('./notion-connector');
		const record = (await notionConnector.get(target, PAGE)).unwrap();

		expect(tools.calls).toEqual([{name: 'notion-fetch', args: {id: PAGE}}]);
		expect(record.values).toEqual({title: 'Plan', path: '', link: URL_OF(PAGE), edited: '2026-09-24T00:38:13.331Z', properties: '', content: '# Plan\n- one'});
	});

	test("only a page's id goes to Notion; a page it can't find is not found", async () => {
		const {notionConnector} = await import('./notion-connector');
		expect((await notionConnector.get(target, 'memory')).unwrapErr()).toMatchObject({kind: 'not_found', id: 'memory'});
		expect(tools.calls).toEqual([]);

		tools.answer = () => Err(ApiErr.notFound('page'));
		expect((await notionConnector.get(target, PAGE)).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record', id: PAGE});
	});
});

describe('notionConnector writes', () => {
	test('a new page is a private draft', async () => {
		tools.answer = ({name}) =>
			name === 'notion-create-pages' ? Ok(JSON.stringify({pages: [{id: '3e4955a6-3d7e-8069-a438-e7961ef050ef', url: URL_OF(PAGE)}]})) : Ok(fetchedPage(PAGE, 'Plan', '# Plan\n- one'));
		const {notionConnector} = await import('./notion-connector');
		const record = (await notionConnector.create(target, {title: 'Plan', content: '# Plan\n- one'})).unwrap();

		expect(tools.calls[0]).toEqual({name: 'notion-create-pages', args: {creation_mode: 'draft', pages: [{properties: {title: 'Plan'}, content: '# Plan\n- one'}]}});
		expect(record.id).toBe(PAGE);
	});

	test('an edit changes only what changed', async () => {
		const {notionConnector} = await import('./notion-connector');
		await notionConnector.update(target, PAGE, {title: 'Plan', content: '# Plan\n- one\n- two'});

		expect(tools.calls.filter((call) => call.name === 'notion-update-page')).toEqual([
			{name: 'notion-update-page', args: {page_id: PAGE, command: 'replace_content', new_str: '# Plan\n- one\n- two'}},
		]);

		tools.calls = [];
		await notionConnector.update(target, PAGE, {title: 'Roadmap', content: '# Plan\n- one'});
		expect(tools.calls.filter((call) => call.name === 'notion-update-page')).toEqual([
			{name: 'notion-update-page', args: {page_id: PAGE, command: 'update_properties', properties: {title: 'Roadmap'}}},
		]);
	});

	test('pages are not deleted', async () => {
		const {notionConnector} = await import('./notion-connector');
		expect((await notionConnector.remove(target, PAGE)).isErr()).toBe(true);
		expect(tools.calls).toEqual([]);
	});
});
