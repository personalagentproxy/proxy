import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')}}));

const listInfoRecords = mock();
const getInfoRecord = mock();
const createInfoRecord = mock();
const updateInfoRecord = mock();
const deleteInfoRecord = mock();

mock.module('@proxy/db/info', () => ({listInfoRecords, getInfoRecord, createInfoRecord, updateInfoRecord, deleteInfoRecord}));

function notes(): Collection {
	const integration = findIntegration('info');
	const found = integration && findCollection(integration, 'notes');
	if (!found) {
		throw new Error('No notes collection');
	}
	return found;
}

const target = {
	connection: {id: 'info-1', integrationId: 'info', account: "Alex's Workspace", createdAt: new Date(), defaults: [], credential: null},
	collection: notes(),
};

const updatedAt = new Date('2026-10-01T00:00:00Z');

beforeEach(() => {
	mock.clearAllMocks();
	createInfoRecord.mockImplementation((_collection: unknown, values: string) => Promise.resolve(Ok({id: 'rec-1', values, updatedAt})));
});

describe('infoConnector', () => {
	test('stores the values encrypted and reads them back', async () => {
		const {infoConnector} = await import('./info-connector');
		const created = await infoConnector.create(target, {title: 'Sizes', body: 'Shoes: EU 43'});

		const [collection, stored] = createInfoRecord.mock.calls[0] ?? [];
		expect(collection).toEqual({connectionId: 'info-1', collectionId: 'notes'});
		expect(String(stored)).not.toContain('Shoes');
		expect(created.unwrap()).toEqual({id: 'rec-1', values: {title: 'Sizes', body: 'Shoes: EU 43'}, updatedAt: '2026-10-01T00:00:00.000Z'});

		listInfoRecords.mockResolvedValue(Ok([{id: 'rec-1', values: stored, updatedAt}]));
		const listed = await infoConnector.list(target, {search: null, page: null});
		expect(listed.unwrap().records[0]?.values).toEqual({title: 'Sizes', body: 'Shoes: EU 43'});
		expect(listed.unwrap().nextPage).toBeNull();
	});

	test('searches every value, ignoring case', async () => {
		const {infoConnector} = await import('./info-connector');
		const sizes = (await infoConnector.create(target, {title: 'Sizes', body: 'Shoes: EU 43'})).unwrap();
		const diet = (await infoConnector.create(target, {title: 'Diet', body: 'Vegetarian'})).unwrap();
		const [, sizesStored] = createInfoRecord.mock.calls[0] ?? [];
		const [, dietStored] = createInfoRecord.mock.calls[1] ?? [];
		listInfoRecords.mockResolvedValue(
			Ok([
				{...sizes, values: sizesStored, updatedAt},
				{...diet, values: dietStored, updatedAt},
			]),
		);

		const found = await infoConnector.list(target, {search: 'shoes', page: null});
		expect(found.unwrap().records.map((record) => record.values.title)).toEqual(['Sizes']);
	});

	test('a missing record is not found', async () => {
		getInfoRecord.mockResolvedValue(Ok(null));

		const {infoConnector} = await import('./info-connector');
		const result = await infoConnector.get(target, 'other');

		expect(result.unwrapErr().kind).toBe('not_found');
	});

	test('an unreadable record is an internal error', async () => {
		getInfoRecord.mockResolvedValue(Ok({id: 'rec-1', values: 'v1.not.encrypted.here', updatedAt}));

		const {infoConnector} = await import('./info-connector');
		const result = await infoConnector.get(target, 'rec-1');

		expect(result.unwrapErr().kind).toBe('internal_error');
	});
});
