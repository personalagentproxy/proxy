import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {SECRET_NAME_PATTERN, VAULT_SECRETS_COLLECTION_ID} from '@proxy/integrations';
import {createVaultEntry, deleteVaultEntry, getVaultEntry, listVaultEntries, updateVaultEntry, type VaultCollection, type VaultEntryRow} from '@proxy/db/vault';

import {decryptSecret, encryptSecret} from '../../utils/secret-crypto';
import {requireFirstPage, type DataRecord, type RecordStore, type RecordTarget, type RecordValues} from '../../records/connector';

const storedValuesSchema = z.record(z.string(), z.string());

function vaultCollection(target: RecordTarget): VaultCollection {
	return {connectionId: target.connection.id, collectionId: target.collection.id};
}

function isSecrets(target: RecordTarget): boolean {
	return target.collection.id === VAULT_SECRETS_COLLECTION_ID;
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

// An entry without a type is Text, as its row shows it; a secret has none.
function withType(target: RecordTarget, values: RecordValues): RecordValues {
	if (isSecrets(target)) {
		return values;
	}
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

function listRecords(collection: VaultCollection): Promise<Result<DataRecord[], ApiError>> {
	return Do(async ($) => {
		const rows = $(await listVaultEntries(collection));
		return rows.map((row) => $(toRecord(row)));
	});
}

/** A vault's secrets, each by its name and value, as a sandbox command is given them (native/sandbox/secrets.ts). */
export function listSecrets(connectionId: string): Promise<Result<Array<{name: string; value: string}>, ApiError>> {
	return Do(async ($) => {
		const records = $(await listRecords({connectionId, collectionId: VAULT_SECRETS_COLLECTION_ID}));
		return records.map((record) => ({name: record.values.name ?? '', value: record.values.value ?? ''}));
	});
}

// A secret needs a name a command's environment can have, one no other secret of the vault has,
// and a value. `id` is the secret's own, where it is being changed.
function requireSecret(target: RecordTarget, values: RecordValues, id: string | null): Promise<Result<RecordValues, ApiError>> {
	return Do(async ($) => {
		const name = (values.name ?? '').trim();
		if (!SECRET_NAME_PATTERN.test(name)) {
			return $(Err(ApiErr.validationError('A secret’s name is an environment variable’s: letters, digits and _, not starting with a digit, as OPENAI_API_KEY')));
		}
		if ((values.value ?? '') === '') {
			return $(Err(ApiErr.validationError('A secret needs a value')));
		}
		const others = $(await listRecords(vaultCollection(target)));
		if (others.some((other) => other.id !== id && other.values.name === name)) {
			return $(Err(ApiErr.conflict(`This vault has a secret called ${name} already`)));
		}
		return {name, value: values.value ?? '', note: values.note ?? ''};
	});
}

// What a write keeps: an entry with its type, or a secret as it has to be.
function written(target: RecordTarget, values: RecordValues, id: string | null): Promise<Result<RecordValues, ApiError>> {
	if (isSecrets(target)) {
		return requireSecret(target, values, id);
	}
	return Promise.resolve(Ok(withType(target, values)));
}

/**
 * The vault lives in Personal Agent Proxy: each entry's title, type and content, and each secret's
 * name, value and note, are stored as encrypted JSON. A search reads every field but those never
 * given to an agent, a secret's value.
 */
export const vaultConnector = {
	// Few enough to search in memory, after decrypting, and to list on one page.
	list: (target, query) =>
		Do(async ($) => {
			$(requireFirstPage(query));
			const records = $(await listRecords(vaultCollection(target)));
			const search = query.search?.toLowerCase();
			const searched = target.collection.fields.filter((field) => !field.secret).map((field) => field.key);
			const matching = search ? records.filter((record) => searched.some((key) => (record.values[key] ?? '').toLowerCase().includes(search))) : records;
			return {records: matching, nextPage: null};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const row = $(await getVaultEntry(vaultCollection(target), recordId));
			return $(toRecord($(requirePresent(row, ApiErr.notFound('record', recordId)))));
		}),
	create: (target, values) =>
		Do(async ($) => {
			if (!isSecrets(target)) {
				$(requireWritten(values));
			}
			const kept = $(await written(target, values, null));
			const row = $(await createVaultEntry(vaultCollection(target), $(encryptValues(kept))));
			return $(toRecord(row));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const kept = $(await written(target, values, recordId));
			const row = $(await updateVaultEntry(vaultCollection(target), recordId, $(encryptValues(kept))));
			return $(toRecord(row));
		}),
	remove: (target, recordId) => deleteVaultEntry(vaultCollection(target), recordId),
} satisfies RecordStore;
