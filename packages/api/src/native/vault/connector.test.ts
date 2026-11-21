import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('../../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')}}));

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
	connection: {
		id: 'vault-1',
		integrationId: 'vault',
		orgId: 'org-1',
		ownerUserId: 'user-1',
		sharedWithEveryone: false,
		shares: [],
		account: "Alex's Workspace",
		createdAt: new Date(),
		tools: null,
		name: null,
		defaults: [],
		credentialRejectedAt: null,
		credential: null,
	},
	collection: entries(),
};

const updatedAt = new Date('2026-10-01T00:00:00Z');

beforeEach(() => {
	mock.clearAllMocks();
	createVaultEntry.mockImplementation((_collection: unknown, values: string) => Promise.resolve(Ok({id: 'rec-1', values, updatedAt})));
});

describe('vaultConnector', () => {
	test('stores the values encrypted and reads them back', async () => {
		const {vaultConnector} = await import('./connector');
		const created = await vaultConnector.create(target, {title: 'Sizes', type: 'Text', content: 'Shoes: EU 43'});

		const [collection, stored] = createVaultEntry.mock.calls[0] ?? [];
		expect(collection).toEqual({connectionId: 'vault-1', collectionId: 'entries'});
		expect(String(stored)).not.toContain('Shoes');
		expect(created.unwrap()).toEqual({id: 'rec-1', values: {title: 'Sizes', type: 'Text', content: 'Shoes: EU 43'}, updatedAt: '2026-10-01T00:00:00.000Z'});

		listVaultEntries.mockResolvedValue(Ok([{id: 'rec-1', values: stored, updatedAt}]));
		const listed = await vaultConnector.list(target, {search: null, page: null, filter: null, parent: null});
		expect(listed.unwrap().records[0]?.values).toEqual({title: 'Sizes', type: 'Text', content: 'Shoes: EU 43'});
		expect(listed.unwrap().nextPage).toBeNull();
	});

	test('searches every value, ignoring case', async () => {
		const {vaultConnector} = await import('./connector');
		const sizes = (await vaultConnector.create(target, {title: 'Sizes', type: 'Text', content: 'Shoes: EU 43'})).unwrap();
		const diet = (await vaultConnector.create(target, {title: 'Diet', type: 'Text', content: 'Vegetarian'})).unwrap();
		const [, sizesStored] = createVaultEntry.mock.calls[0] ?? [];
		const [, dietStored] = createVaultEntry.mock.calls[1] ?? [];
		listVaultEntries.mockResolvedValue(
			Ok([
				{...sizes, values: sizesStored, updatedAt},
				{...diet, values: dietStored, updatedAt},
			]),
		);

		const found = await vaultConnector.list(target, {search: 'shoes', page: null, filter: null, parent: null});
		expect(found.unwrap().records.map((record) => record.values.title)).toEqual(['Sizes']);
	});

	test('a page is refused, since every entry is on the one page', async () => {
		const {vaultConnector} = await import('./connector');
		const result = await vaultConnector.list(target, {search: null, page: 'next', filter: null, parent: null});

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(listVaultEntries).not.toHaveBeenCalled();
	});

	test('a new entry needs a title or content', async () => {
		const {vaultConnector} = await import('./connector');
		const result = await vaultConnector.create(target, {title: ' ', type: 'Email', content: ''});

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(createVaultEntry).not.toHaveBeenCalled();
	});

	test('an entry without a type is Text', async () => {
		updateVaultEntry.mockImplementation((_collection: unknown, id: string, values: string) => Promise.resolve(Ok({id, values, updatedAt})));

		const {vaultConnector} = await import('./connector');
		const created = await vaultConnector.create(target, {title: 'Sizes', type: '', content: ''});
		const updated = await vaultConnector.update(target, 'rec-1', {title: 'Sizes', type: '', content: 'Shoes: EU 43'});

		expect(created.unwrap().values.type).toBe('Text');
		expect(updated.unwrap().values.type).toBe('Text');
	});

	test('a missing record is not found', async () => {
		getVaultEntry.mockResolvedValue(Ok(null));

		const {vaultConnector} = await import('./connector');
		const result = await vaultConnector.get(target, 'other');

		expect(result.unwrapErr().kind).toBe('not_found');
	});

	test('an unreadable record is an internal error', async () => {
		getVaultEntry.mockResolvedValue(Ok({id: 'rec-1', values: 'v1.not.encrypted.here', updatedAt}));

		const {vaultConnector} = await import('./connector');
		const result = await vaultConnector.get(target, 'rec-1');

		expect(result.unwrapErr().kind).toBe('internal_error');
	});
});

describe('a vault’s secrets', () => {
	function secrets(): Collection {
		const integration = findIntegration('vault');
		const found = integration && findCollection(integration, 'secrets');
		if (!found) {
			throw new Error('No secrets collection');
		}
		return found;
	}

	test('keep a value without the spaces and line breaks pasted around it, and refuse one that is only those', async () => {
		const {vaultConnector} = await import('./connector');
		const kept = {...target, collection: secrets()};
		listVaultEntries.mockResolvedValue(Ok([]));

		const created = await vaultConnector.create(kept, {name: 'API_KEY', value: '  sk-test-123 \n', note: ''});
		expect(created.unwrap().values).toEqual({name: 'API_KEY', value: 'sk-test-123', note: ''});
		expect((await vaultConnector.create(kept, {name: 'API_KEY', value: ' \n', note: ''})).unwrapErr().kind).toBe('validation_error');
	});

	test('refuse a name another secret of the vault has, as they are written, and let a secret keep its own', async () => {
		const {vaultConnector, encryptValues} = await import('./connector');
		const kept = {...target, collection: secrets()};
		const others = [{id: 'rec-2', values: encryptValues({name: 'API_KEY', value: 'sk-other', note: ''}).unwrap(), updatedAt}];
		createVaultEntry.mockImplementation((_collection: unknown, values: string, check?: (rows: typeof others) => Result<void, ApiError>) =>
			Promise.resolve(check ? check(others).map(() => ({id: 'rec-1', values, updatedAt})) : Ok({id: 'rec-1', values, updatedAt})),
		);

		expect((await vaultConnector.create(kept, {name: 'API_KEY', value: 'sk-new', note: ''})).unwrapErr().kind).toBe('conflict');
		expect((await vaultConnector.create(kept, {name: 'OTHER_KEY', value: 'sk-new', note: ''})).isOk()).toBe(true);
	});

	test('are listed for a command without those that can’t be read', async () => {
		const {listSecrets, encryptValues} = await import('./connector');
		listVaultEntries.mockResolvedValue(
			Ok([
				{id: 'rec-1', values: encryptValues({name: 'API_KEY', value: 'sk-one', note: ''}).unwrap(), updatedAt},
				{id: 'rec-2', values: 'v1.not.encrypted.here', updatedAt},
			]),
		);

		expect((await listSecrets('vault-1')).unwrap()).toEqual([{name: 'API_KEY', value: 'sk-one'}]);
	});
});
