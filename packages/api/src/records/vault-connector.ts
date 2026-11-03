import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {createVaultEntry, deleteVaultEntry, getVaultEntry, listVaultEntries, updateVaultEntry, type VaultEntryRow} from '@proxy/db/vault';

import {decryptSecret, encryptSecret} from '../utils/secret-crypto';
import {requireFirstPage, type DataRecord, type RecordStore, type RecordTarget, type RecordValues} from './connector';

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

// An entry without a type is Text, as its row shows it.
function withType(values: RecordValues): RecordValues {
	return {...values, type: values.type || 'Text'};
}

// A new entry needs something written in it: a type chosen alone is nothing, as the vault's own form has it.
function requireWritten(values: RecordValues): Result<void, ApiError> {
	if ([values.title, values.content].some((value) => (value ?? '').trim() !== '')) {
		return Ok(undefined);
	}
	return Err(ApiErr.validationError('An entry needs a title or content'));
}

function toRecord(row: VaultEntryRow): Result<DataRecord, ApiError> {
	return decryptValues(row.values).map((values) => ({id: row.id, values, updatedAt: row.updatedAt.toISOString()}));
}

/** The vault lives in Personal Agent Proxy: each entry's title, type and content are stored as encrypted JSON. */
export const vaultConnector = {
	// Few enough to search in memory, after decrypting, and to list on one page.
	list: (target, query) =>
		Do(async ($) => {
			$(requireFirstPage(query));
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
			$(requireWritten(values));
			const row = $(await createVaultEntry(vaultCollection(target), $(encryptValues(withType(values)))));
			return $(toRecord(row));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const row = $(await updateVaultEntry(vaultCollection(target), recordId, $(encryptValues(withType(values)))));
			return $(toRecord(row));
		}),
	remove: (target, recordId) => deleteVaultEntry(vaultCollection(target), recordId),
} satisfies RecordStore;
