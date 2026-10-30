import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')}}));

const listOldVaultRecords = mock();
const replaceOldVaultRecord = mock();
mock.module('@proxy/db/vault', () => ({
	listOldVaultRecords,
	replaceOldVaultRecord,
	listVaultEntries: mock(),
	getVaultEntry: mock(),
	createVaultEntry: mock(),
	updateVaultEntry: mock(),
	deleteVaultEntry: mock(),
}));

const logged = {debug: mock(), info: mock(), warn: mock(), error: mock()};
mock.module('../observability/log', () => ({log: logged, serializeError: mock(() => ({}))}));

const {convertOldVaultRecords, entryFrom} = await import('./vault-entries');
const {encryptValues} = await import('./vault-connector');

describe('entryFrom', () => {
	test('writes an address out a line at a time, titled by its label', () => {
		const address = {label: 'Home', name: 'Alex Doe', street: '1 Main St', postalCode: '10115', city: 'Berlin', country: 'Germany'};
		expect(entryFrom('addresses', address)).toEqual({title: 'Home', type: 'Address', content: 'Alex Doe\n1 Main St\n10115 Berlin\nGermany'});
	});

	test('leaves out the lines an address has nothing on', () => {
		const address = {label: '', name: '', street: '1 Main St', postalCode: '', city: 'Berlin', country: ''};
		expect(entryFrom('addresses', address)).toEqual({title: 'Address', type: 'Address', content: '1 Main St\nBerlin'});
	});

	test('keeps a note as text, under its title', () => {
		expect(entryFrom('notes', {title: 'Sizes', body: 'Shoes: EU 43'})).toEqual({title: 'Sizes', type: 'Text', content: 'Shoes: EU 43'});
	});

	test('keeps no payment card', () => {
		expect(entryFrom('cards', {label: 'Visa', cardholder: 'A', number: '4242', expiry: '08/28'})).toBeNull();
	});
});

describe('convertOldVaultRecords', () => {
	const note = {id: 'rec-1', collectionId: 'notes', values: encryptValues({title: 'Sizes', body: 'Shoes: EU 43'}).unwrap()};

	beforeEach(() => {
		mock.clearAllMocks();
		replaceOldVaultRecord.mockResolvedValue(Ok(true));
	});

	test('turns each record into an entry, and is done', async () => {
		listOldVaultRecords.mockResolvedValue(Ok([note]));

		expect((await convertOldVaultRecords()).isOk()).toBe(true);

		expect(replaceOldVaultRecord).toHaveBeenCalledTimes(1);
		expect(logged.info).toHaveBeenCalledWith('Turned a record into a vault entry', {recordId: 'rec-1', collectionId: 'notes'});
	});

	test("a record that can't be read stays as it is, logged, and doesn't hold the migration open for the next start", async () => {
		listOldVaultRecords.mockResolvedValue(Ok([{id: 'rec-0', collectionId: 'notes', values: 'not encrypted'}, note]));

		expect((await convertOldVaultRecords()).isOk()).toBe(true);

		expect(replaceOldVaultRecord).toHaveBeenCalledTimes(1);
		expect(logged.error).toHaveBeenCalledWith('A record can’t be turned into a vault entry, and stays as it is', expect.objectContaining({recordId: 'rec-0', kind: 'internal_error'}));
	});

	test('the database out of reach for a record leaves the migration to the next start', async () => {
		listOldVaultRecords.mockResolvedValue(Ok([note]));
		replaceOldVaultRecord.mockResolvedValue(Err(ApiErr.dbError(new Error('connection reset'))));

		expect((await convertOldVaultRecords()).isErr()).toBe(true);

		expect(logged.warn).toHaveBeenCalledWith('Turning a record into a vault entry failed, to be tried again on the next start', expect.objectContaining({recordId: 'rec-1', kind: 'db_error'}));
	});
});
