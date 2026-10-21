import {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {createVaultEntry, deleteVaultEntry, getVaultEntry, listVaultEntries, updateVaultEntry, type VaultEntryRow} from '@proxy/db/vault';

import {decryptSecret, encryptSecret} from '../utils/secret-crypto';
import type {Connector, DataRecord, RecordTarget, RecordValues} from './connector';

const storedValuesSchema = z.record(z.string(), z.string());

function vaultCollection(target: RecordTarget) {
	return {connectionId: target.connection.id, collectionId: target.collection.id};
}

export function encryptValues(values: RecordValues): Result<string, ApiError> {
	return encryptSecret(JSON.stringify(values));
}

export function decryptValues(stored: string): Result<RecordValues, ApiError> {
	return Do<RecordValues, ApiError>(($) => {
		const json = $(decryptSecret(stored));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		return $(parseSchema(storedValuesSchema, parsed));
	});
}

function toRecord(row: VaultEntryRow): Result<DataRecord, ApiError> {
	return decryptValues(row.values).map((values) => ({id: row.id, values, updatedAt: row.updatedAt.toISOString()}));
}

/** The vault lives in Personal Agent Proxy: each entry's title, type and content are stored as encrypted JSON. */
export const vaultConnector: Connector = {
	// Few enough to search in memory, after decrypting, and to list on one page.
	list: (target, query) =>
		Do(async ($) => {
			const rows = $(await listVaultEntries(vaultCollection(target)));
			const records = rows.map((row) => $(toRecord(row)));
			const search = query.search?.toLowerCase();
			const matching = search ? records.filter((record) => Object.values(record.values).some((value) => value.toLowerCase().includes(search))) : records;
			return {records: matching, nextPage: null};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const row = $(await getVaultEntry(vaultCollection(target), recordId));
			return $(toRecord($(requirePresent(row, ApiErr.notFound('record', recordId)))));
		}),
	create: (target, values) =>
		Do(async ($) => {
			const row = $(await createVaultEntry(vaultCollection(target), $(encryptValues(values))));
			return $(toRecord(row));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const row = $(await updateVaultEntry(vaultCollection(target), recordId, $(encryptValues(values))));
			return $(toRecord(row));
		}),
	remove: (target, recordId) => deleteVaultEntry(vaultCollection(target), recordId),
};
