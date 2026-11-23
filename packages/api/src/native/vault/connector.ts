import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {SECRET_NAME_PATTERN, VAULT_SECRETS_COLLECTION_ID} from '@proxy/integrations';
import {createVaultEntry, deleteVaultEntry, getVaultEntry, listVaultEntries, updateVaultEntry, type VaultCollection, type VaultEntriesCheck, type VaultEntryRow} from '@proxy/db/vault';

import {log} from '../../observability/log';
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

function listRecords(collection: VaultCollection): Promise<Result<DataRecord[], ApiError>> {
	return Do(async ($) => {
		const rows = $(await listVaultEntries(collection));
		return rows.map((row) => $(toRecord(row)));
	});
}

/**
 * A vault's secrets, each by its name and value, as a sandbox command is given them
 * (native/sandbox/secrets.ts). One that can't be read is left out and logged rather than failing
 * the rest: its value can't be given to a command, nor found in what one writes.
 */
export function listSecrets(connectionId: string): Promise<Result<Array<{name: string; value: string}>, ApiError>> {
	return Do(async ($) => {
		const rows = $(await listVaultEntries({connectionId, collectionId: VAULT_SECRETS_COLLECTION_ID}));
		return rows.flatMap((row) => {
			const values = decryptValues(row.values);
			if (values.isErr()) {
				log.warn('A vault secret could not be read', {connectionId, recordId: row.id, errorKind: values.error.kind});
				return [];
			}
			return [{name: values.value.name ?? '', value: values.value.value ?? ''}];
		});
	});
}

// A secret needs a name a command's environment can have and a value, kept without the spaces and
// line breaks around it, which a paste brings along and a command's output may leave off, so that
// masking finds the value as printed (secret-values.ts).
function requireSecret(values: RecordValues): Result<RecordValues, ApiError> {
	const name = (values.name ?? '').trim();
	if (!SECRET_NAME_PATTERN.test(name)) {
		return Err(ApiErr.validationError('A secret’s name is an environment variable’s: letters, digits and _, not starting with a digit, as OPENAI_API_KEY'));
	}
	const value = (values.value ?? '').trim();
	if (value === '') {
		return Err(ApiErr.validationError('A secret needs a value'));
	}
	return Ok({name, value, note: values.note ?? ''});
}

// No other secret of the vault has the name: checked as the secret is written, with the vault's
// other writes of secrets held off (@proxy/db/vault), so two at once can't both take it.
function nameFree(name: string): VaultEntriesCheck {
	return (others) => {
		const taken = others.some((other) => decryptValues(other.values).mapOr(false, (values) => values.name === name));
		if (taken) {
			return Err(ApiErr.conflict(`This vault has a secret called ${name} already`));
		}
		return Ok(undefined);
	};
}

// What a write keeps, and what it checks of the collection's others as it writes: an entry with
// its type, one new needing something written in it; or a secret as it has to be, its name the
// vault's only one.
function written(target: RecordTarget, values: RecordValues, isNew: boolean): Result<{kept: RecordValues; check?: VaultEntriesCheck}, ApiError> {
	if (isSecrets(target)) {
		return requireSecret(values).map((kept) => ({kept, check: nameFree(kept.name ?? '')}));
	}
	if (isNew) {
		return requireWritten(values).map(() => ({kept: withType(values)}));
	}
	return Ok({kept: withType(values)});
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
			const {kept, check} = $(written(target, values, true));
			const row = $(await createVaultEntry(vaultCollection(target), $(encryptValues(kept)), check));
			return $(toRecord(row));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const {kept, check} = $(written(target, values, false));
			const row = $(await updateVaultEntry(vaultCollection(target), recordId, $(encryptValues(kept)), check));
			return $(toRecord(row));
		}),
	remove: (target, recordId) => deleteVaultEntry(vaultCollection(target), recordId),
} satisfies RecordStore;
