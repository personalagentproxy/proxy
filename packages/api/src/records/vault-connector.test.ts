import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')}}));

const listVaultEntries = mock();
const getVaultEntry = mock();
const createVaultEntry = mock();
const updateVaultEntry = mock();
const deleteVaultEntry = mock();

mock.module('@proxy/db/vault', () => ({listVaultEntries, getVaultEntry, createVaultEntry, updateVaultEntry, deleteVaultEntry}));

function entries(): Collection {
	const integration = findIntegration('vault');
	const found = integration && findCollection(integration, 'entries');
	if (!found) {
		throw new Error('No entries collection');
	}
	return found;
}

const target = {
	connection: {id: 'vault-1', integrationId: 'vault', account: "Alex's Workspace", createdAt: new Date(), tools: null, name: null, defaults: [], credential: null},
	collection: entries(),
};

const updatedAt = new Date('2026-10-01T00:00:00Z');

beforeEach(() => {
	mock.clearAllMocks();
	createVaultEntry.mockImplementation((_collection: unknown, values: string) => Promise.resolve(Ok({id: 'rec-1', values, updatedAt})));
});

describe('vaultConnector', () => {
	test('stores the values encrypted and reads them back', async () => {
		const {vaultConnector} = await import('./vault-connector');
		const created = await vaultConnector.create(target, {key: 'Sizes', type: 'Text', value: 'Shoes: EU 43'}, null);

		const [collection, stored] = createVaultEntry.mock.calls[0] ?? [];
		expect(collection).toEqual({connectionId: 'vault-1', collectionId: 'entries'});
		expect(String(stored)).not.toContain('Shoes');
		expect(created.unwrap()).toEqual({id: 'rec-1', values: {key: 'Sizes', type: 'Text', value: 'Shoes: EU 43'}, updatedAt: '2026-10-01T00:00:00.000Z'});

		listVaultEntries.mockResolvedValue(Ok([{id: 'rec-1', values: stored, updatedAt}]));
		const listed = await vaultConnector.list(target, {search: null, page: null, filter: null, parent: null});
		expect(listed.unwrap().records[0]?.values).toEqual({key: 'Sizes', type: 'Text', value: 'Shoes: EU 43'});
		expect(listed.unwrap().nextPage).toBeNull();
	});

	test('searches every value, ignoring case', async () => {
		const {vaultConnector} = await import('./vault-connector');
		const sizes = (await vaultConnector.create(target, {key: 'Sizes', type: 'Text', value: 'Shoes: EU 43'}, null)).unwrap();
		const diet = (await vaultConnector.create(target, {key: 'Diet', type: 'Text', value: 'Vegetarian'}, null)).unwrap();
		const [, sizesStored] = createVaultEntry.mock.calls[0] ?? [];
		const [, dietStored] = createVaultEntry.mock.calls[1] ?? [];
		listVaultEntries.mockResolvedValue(
			Ok([
				{...sizes, values: sizesStored, updatedAt},
				{...diet, values: dietStored, updatedAt},
			]),
		);

		const found = await vaultConnector.list(target, {search: 'shoes', page: null, filter: null, parent: null});
		expect(found.unwrap().records.map((record) => record.values.key)).toEqual(['Sizes']);
	});

	test('a missing record is not found', async () => {
		getVaultEntry.mockResolvedValue(Ok(null));

		const {vaultConnector} = await import('./vault-connector');
		const result = await vaultConnector.get(target, 'other');

		expect(result.unwrapErr().kind).toBe('not_found');
	});

	test('an unreadable record is an internal error', async () => {
		getVaultEntry.mockResolvedValue(Ok({id: 'rec-1', values: 'v1.not.encrypted.here', updatedAt}));

		const {vaultConnector} = await import('./vault-connector');
		const result = await vaultConnector.get(target, 'rec-1');

		expect(result.unwrapErr().kind).toBe('internal_error');
	});
});
