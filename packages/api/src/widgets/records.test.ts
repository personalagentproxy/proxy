import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration} from '@proxy/integrations';

const list = mock();
const findSources = mock();

mock.module('./sources', () => ({findSources, summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id})}));
mock.module('../utils/user-org', () => ({requireUserOrgId: async () => Ok('org-1')}));

function source(integrationId: string, collectionId: string) {
	const integration = findIntegration(integrationId);
	return {connection: {id: `${integrationId}-1`}, integration, collection: integration && findCollection(integration, collectionId), connector: {list}};
}

function request(query: Record<string, string | string[]>) {
	return {user: {userId: 'user-1', experiments: ['ask']}, query} as never;
}

beforeEach(() => {
	list.mockReset();
	findSources.mockReset();
});

describe('handleFindRecordsRoute', () => {
	test("searches Notion's pages with the words, leaving out databases and views", async () => {
		findSources.mockResolvedValue(Ok([source('notion', 'pages')]));
		list.mockResolvedValue(
			Ok({
				records: [
					{id: 'p1', values: {title: 'Pricing FAQ', kind: 'Page'}, updatedAt: '2026-10-02', url: 'https://www.notion.so/p1'},
					{id: 'd1', values: {title: 'Pricing experiments', kind: 'Database'}, updatedAt: '2026-10-01'},
				],
				nextPage: null,
			}),
		);
		const {handleFindRecordsRoute} = await import('./records');
		const found = (await handleFindRecordsRoute(request({collection: 'pages', words: ['pricing', 'faq']}))).unwrap();
		expect(findSources).toHaveBeenCalledWith('org-1', 'pages', 'list');
		expect(list.mock.calls[0]?.[1]).toEqual({search: 'pricing faq', page: null, filter: null, parent: null});
		expect(found.records).toEqual([{connectionId: 'notion-1', id: 'p1', title: 'Pricing FAQ', updated: '2026-10-02', link: 'https://www.notion.so/p1'}]);
	});

	test("lists Linear's newest issues when no words are given", async () => {
		findSources.mockResolvedValue(Ok([source('linear', 'issues')]));
		list.mockResolvedValue(Ok({records: [{id: 'ENG-12', values: {title: 'Checkout fails on Safari'}, updatedAt: '2026-10-13'}], nextPage: null}));
		const {handleFindRecordsRoute} = await import('./records');
		const found = (await handleFindRecordsRoute(request({collection: 'issues'}))).unwrap();
		expect(list.mock.calls[0]?.[1]).toMatchObject({search: null});
		expect(found.records.map((record) => record.title)).toEqual(['Checkout fails on Safari']);
	});

	test('searches no other collection', async () => {
		const {handleFindRecordsRoute} = await import('./records');
		const found = await handleFindRecordsRoute(request({collection: 'cards'}));
		expect(found.isErr()).toBe(true);
		expect(findSources).not.toHaveBeenCalled();
	});
});
