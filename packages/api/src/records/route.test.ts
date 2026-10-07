import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

const requireUserOrgId = mock();

mock.module('../utils/user-org', () => ({requireUserOrgId}));

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

const record = {id: 'rec-1', values: {title: 'Sizes', body: ''}, updatedAt: '2026-10-01T00:00:00.000Z'};

function makeRequest(params: Record<string, string>, body: unknown = undefined) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params, body, query: {}} as never;
}

function useCollection(integrationId: string, collectionId: string) {
	loadRecordTarget.mockResolvedValue(Ok({connection: {id: 'conn-1'}, collection: collection(integrationId, collectionId), connector}));
}

beforeEach(() => {
	mock.clearAllMocks();
	requireUserOrgId.mockResolvedValue(Ok('org-1'));
	useCollection('info', 'notes');
	connector.list.mockResolvedValue(Ok({records: [record], nextPage: null}));
	connector.create.mockResolvedValue(Ok(record));
});

describe('records routes', () => {
	test("list the collection's records in the user's organization", async () => {
		const {handleListRecordsRoute} = await import('./route');
		const result = await handleListRecordsRoute(makeRequest({connectionId: 'conn-1', collectionId: 'notes'}));

		expect(loadRecordTarget).toHaveBeenCalledWith('org-1', 'conn-1', 'notes');
		expect(connector.list.mock.calls[0]?.[1]).toEqual({search: null, page: null, filter: null});
		expect(result.unwrap()).toEqual({records: [record], nextPage: null});
	});

	test('create with the parsed values', async () => {
		const {handleCreateRecordRoute} = await import('./route');
		const result = await handleCreateRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'notes'}, {values: {title: 'Sizes'}}));

		expect(connector.create.mock.calls[0]?.[1]).toEqual({title: 'Sizes', body: ''});
		expect(result.unwrap()).toEqual(record);
	});

	test("refuse writes the collection doesn't offer", async () => {
		const readOnly = {...collection('info', 'notes'), writes: {}};
		loadRecordTarget.mockResolvedValue(Ok({connection: {id: 'conn-1'}, collection: readOnly, connector}));

		const {handleCreateRecordRoute, handleDeleteRecordRoute} = await import('./route');
		const created = await handleCreateRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'notes'}, {values: {}}));
		const deleted = await handleDeleteRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'notes', recordId: 'rec-1'}));

		expect(created.unwrapErr().kind).toBe('forbidden');
		expect(deleted.unwrapErr().kind).toBe('forbidden');
		expect(connector.create).not.toHaveBeenCalled();
		expect(connector.remove).not.toHaveBeenCalled();
	});

	test('refuse values the collection does not have', async () => {
		const {handleUpdateRecordRoute} = await import('./route');
		const result = await handleUpdateRecordRoute(makeRequest({connectionId: 'conn-1', collectionId: 'notes', recordId: 'rec-1'}, {values: {color: 'red'}}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(connector.update).not.toHaveBeenCalled();
	});
});
