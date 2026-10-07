import {describe, expect, test} from 'bun:test';

import {notionPageId, parseNotionCreated, parseNotionPage, parseNotionRecent, parseNotionSearch, NOTION} from './notion-mcp';

const PAGE = '3e4955a63d7e8069a438e7961ef050ef';
const ROW = '3e9955a63d7e81a0b356e2f6608e90e1';

// What notion-fetch answers, the page's text as Notion writes it for models.
function fetched(args: {type?: string; url: string; title: string; icon?: object | null; path?: string; edited?: string; body: string}): string {
	return JSON.stringify({
		metadata: {type: args.type ?? 'page'},
		title: args.title,
		url: `${args.url}?pvs=204`,
		cover: null,
		icon: args.icon ?? null,
		...(args.path ? {path: args.path} : {}),
		verification: {state: 'unverified'},
		...(args.edited ? {page_last_edited_at: args.edited} : {}),
		text: `Here is the result of "fetch" for the Page with URL ${args.url} as of 2026-09-28T22:43:27.600Z:\n<page url="${args.url}">\n<ancestor-path></ancestor-path>\n${args.body}\n</page>`,
	});
}

describe('notionPageId', () => {
	test('takes 32 hex digits, with or without dashes, and nothing else', () => {
		expect(notionPageId('3E4955A6-3d7e-8069-a438-e7961ef050ef')).toBe(PAGE);
		expect(notionPageId(PAGE)).toBe(PAGE);
		expect(notionPageId('memory')).toBeNull();
		expect(notionPageId(`https://app.notion.com/p/${PAGE}`)).toBeNull();
		expect(notionPageId('collection://3e4955a6-3d7e-8086-b78e-000b4f38d6a4')).toBeNull();
	});
});

describe('parseNotionRecent', () => {
	test('reads the pages by the id in their address, leaving databases out, and the next cursor', () => {
		const text = JSON.stringify({
			results: [
				{type: 'page', url: `https://app.notion.com/p/${PAGE}?pvs=204`, title: 'Outreach', icon: '🦁'},
				{type: 'database', url: 'https://app.notion.com/p/3e4955a63d7e80fbb098de47972ece1a?pvs=204', title: 'Companies'},
				{type: 'page', url: `https://app.notion.com/p/${ROW}?pvs=204`, title: ''},
			],
			nextCursor: 'offset:3',
		});

		expect(parseNotionRecent(text).unwrap()).toEqual({
			pages: [
				{id: PAGE, title: 'Outreach', url: `https://app.notion.com/p/${PAGE}`, path: '', day: null},
				{id: ROW, title: 'Untitled', url: `https://app.notion.com/p/${ROW}`, path: '', day: null},
			],
			nextCursor: 'offset:3',
		});
		expect(parseNotionRecent(JSON.stringify({results: []})).unwrap()).toEqual({pages: [], nextCursor: null});
	});
});

describe('parseNotionSearch', () => {
	test("reads the pages it found, where they are and the day they were edited, and leaves other tools' results out", () => {
		const text = JSON.stringify({
			results: [
				{
					id: '3e9955a6-3d7e-81a0-b356-e2f6608e90e1',
					title: 'Acme GmbH',
					url: `https://app.notion.com/p/${ROW}?pvs=204`,
					type: 'page',
					timestamp: '9 days ago (2026-09-28)',
					path: 'Outreach / Companies',
				},
				{id: 'C0123', title: 'Message in #sales', url: 'https://acme.slack.com/archives/C0123', type: 'slack'},
			],
			type: 'ai_search',
		});

		expect(parseNotionSearch(text).unwrap()).toEqual([{id: ROW, title: 'Acme GmbH', url: `https://app.notion.com/p/${ROW}`, path: 'Outreach / Companies', day: '2026-09-28'}]);
	});

	test('refuses what is not a search answer', () => {
		expect(parseNotionSearch('Something else').isErr()).toBe(true);
	});
});

describe('parseNotionPage', () => {
	test('reads a page: its title without the emoji Notion puts first, and its content as written', () => {
		const text = fetched({
			url: `https://app.notion.com/p/${PAGE}`,
			title: '🦁 Outreach',
			icon: {type: 'emoji', emoji: '🦁'},
			edited: '2026-09-24T00:38:13.331Z',
			body: `<properties>\n{"title":"Outreach"}\n</properties>\n<iconMetadata>{"type":"emoji","emoji":"🦁"}</iconMetadata>\n<content>\n<database url="https://app.notion.com/p/3e4955a63d7e80fbb098de47972ece1a" inline="false"></database>\n> **How we keep this**\n- one\n</content>`,
		});

		expect(parseNotionPage(text).unwrap()).toEqual({
			id: PAGE,
			title: 'Outreach',
			url: `https://app.notion.com/p/${PAGE}`,
			path: '',
			edited: '2026-09-24T00:38:13.331Z',
			properties: '',
			content: '<database url="https://app.notion.com/p/3e4955a63d7e80fbb098de47972ece1a" inline="false"></database>\n> **How we keep this**\n- one',
		});
	});

	test("reads a database row's properties, leaving out empty ones, the title and what Notion doesn't resolve", () => {
		const properties = {
			Company: 'Acme GmbH',
			Status: 'Contacted',
			Size: 100,
			'Call notes': '',
			Contacts: [`https://app.notion.com/p/${PAGE}`],
			'Last contact': 'formulaResult://3e4955a6-3d7e-8086-b78e-000b4f38d6a4/x',
			url: `https://app.notion.com/p/${ROW}`,
		};
		const text = fetched({
			url: `https://app.notion.com/p/${ROW}`,
			title: 'Acme GmbH',
			path: 'Outreach / Companies',
			body: `<properties>\n${JSON.stringify(properties)}\n</properties>\n<iconMetadata>null</iconMetadata>\n<blank-page>This page is blank and has no content.</blank-page>`,
		});

		const page = parseNotionPage(text).unwrap();
		expect(page.path).toBe('Outreach / Companies');
		expect(page.properties).toBe(`Status: Contacted\nSize: 100\nContacts: https://app.notion.com/p/${PAGE}`);
		expect(page.content).toBe('');
	});

	test('a database is not a page', () => {
		const text = fetched({type: 'database', url: 'https://app.notion.com/p/f91af60b3d9e4b9e96888be50a159f26', title: 'Contacts', body: 'The title of this Database is: Contacts'});
		expect(parseNotionPage(text).unwrapErr().kind).toBe('not_found');
	});
});

describe('parseNotionCreated', () => {
	test('reads the id of the page made', () => {
		expect(parseNotionCreated(JSON.stringify({pages: [{id: '3e4955a6-3d7e-8069-a438-e7961ef050ef', url: `https://app.notion.com/p/${PAGE}`}]})).unwrap()).toBe(PAGE);
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
