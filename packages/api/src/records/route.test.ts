import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('../utils/user-org', () => ({
	requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}),
}));

const loadRecordTarget = mock();

mock.module('./target', () => ({loadRecordTarget}));

function collection(integrationId: string, collectionId: string): Collection {
	const integration = findIntegration(integrationId);
	const found = integration && findCollection(integration, collectionId);
	if (!found) {
		throw new Error(`No collection ${integrationId}/${collectionId}`);
	}
	return found;
}

const connector = {list: mock(), get: mock(), create: mock(), update: mock(), remove: mock()};

const record = {id: 'rec-1', values: {title: 'Sizes', type: '', content: ''}, updatedAt: '2026-10-01T00:00:00.000Z'};

function makeRequest(params: Record<string, string>, body: unknown = undefined) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params, body, query: {}} as never;
}

function useCollection(integrationId: string, collectionId: string) {
	loadRecordTarget.mockResolvedValue(Ok({connection: {id: 'conn-1'}, collection: collection(integrationId, collectionId), connector}));
}

beforeEach(() => {
	mock.clearAllMocks();
	useCollection('vault', 'entries');
	connector.list.mockResolvedValue(Ok({records: [record], nextPage: null}));
	connector.create.mockResolvedValue(Ok(record));
});

describe('records routes', () => {
	test("list the collection's records in the user's organization", async () => {
		const {handleListRecordsRoute} = await import('./route');
		const result = await handleListRecordsRoute(makeRequest({connectionId: 'conn-1', collectionId: 'entries'}));

		expect(loadRecordTarget).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-1', 'entries');
		expect(connector.list.mock.calls[0]?.[1]).toEqual({search: null, page: null, filter: null, parent: null});
		expect(result.unwrap()).toEqual({records: [record], nextPage: null});
	});

	test('create with the parsed values', async () => {
		const {handleCreateRecordRoute} = await import('./route');
		const result = await handleCreateRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'entries'}, {values: {title: 'Sizes'}}));

		expect(connector.create.mock.calls[0]?.[1]).toEqual({title: 'Sizes', type: '', content: ''});
		expect(result.unwrap()).toEqual(record);
	});

	test("refuse writes the collection doesn't offer", async () => {
		const readOnly = {...collection('vault', 'entries'), writes: {}};
		loadRecordTarget.mockResolvedValue(Ok({connection: {id: 'conn-1'}, collection: readOnly, connector}));

		const {handleCreateRecordRoute, handleDeleteRecordRoute} = await import('./route');
		const created = await handleCreateRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'entries'}, {values: {}}));
		const deleted = await handleDeleteRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'entries', recordId: 'rec-1'}));

		expect(created.unwrapErr().kind).toBe('forbidden');
		expect(deleted.unwrapErr().kind).toBe('forbidden');
		expect(connector.create).not.toHaveBeenCalled();
		expect(connector.remove).not.toHaveBeenCalled();
	});

	test('refuse to list or open a collection that is only run', async () => {
		const run = {newCommands: {run: mock()}};
		loadRecordTarget.mockResolvedValue(Ok({connection: {id: 'conn-1'}, collection: collection('exa', 'searches'), connector: run}));

		const {handleListRecordsRoute, handleGetRecordRoute} = await import('./route');
		const listed = await handleListRecordsRoute(makeRequest({connectionId: 'conn-1', collectionId: 'searches'}));
		const opened = await handleGetRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'searches', recordId: 'search'}));

		expect(listed.unwrapErr().kind).toBe('forbidden');
		expect(opened.unwrapErr().kind).toBe('forbidden');
		expect(run.newCommands.run).not.toHaveBeenCalled();
	});

	test('refuse values the collection does not have', async () => {
		const {handleUpdateRecordRoute} = await import('./route');
		const result = await handleUpdateRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'entries', recordId: 'rec-1'}, {values: {color: 'red'}}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(connector.update).not.toHaveBeenCalled();
	});
});
