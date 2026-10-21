import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent, wrapDb} from '@proxy/utils';

import {db} from '.';

// `values` is encrypted JSON; this package never sees it in the clear.
export type VaultEntryRow = {id: string; values: string; updatedAt: Date};

export type VaultCollection = {connectionId: string; collectionId: string};

const vaultEntrySelect = {id: true, values: true, updatedAt: true} as const;

export async function listVaultEntries(
	collection: VaultCollection,
): Promise<Result<VaultEntryRow[], ApiError>> {
	return wrapDb(() =>
		db.vaultEntry.findMany({
			where: collection,
			select: vaultEntrySelect,
			orderBy: {createdAt: 'desc'},
		}),
	);
}

/** `Ok(null)` means no such entry in the collection. */
export async function getVaultEntry(
	collection: VaultCollection,
	recordId: string,
): Promise<Result<VaultEntryRow | null, ApiError>> {
	return wrapDb(() =>
		db.vaultEntry.findFirst({where: {...collection, id: recordId}, select: vaultEntrySelect}),
	);
}

export async function createVaultEntry(
	collection: VaultCollection,
	values: string,
): Promise<Result<VaultEntryRow, ApiError>> {
	return wrapDb(() =>
		db.vaultEntry.create({data: {...collection, values}, select: vaultEntrySelect}),
	);
}

/** Fails with not_found when the entry isn't in the collection. */
export async function updateVaultEntry(
	collection: VaultCollection,
	recordId: string,
	values: string,
): Promise<Result<VaultEntryRow, ApiError>> {
	return Do(async ($) => {
		const {count} = $(
			await wrapDb(() =>
				db.vaultEntry.updateMany({where: {...collection, id: recordId}, data: {values}}),
			),
		);
		if (count === 0) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}

		const row = $(await getVaultEntry(collection, recordId));
		return $(requirePresent(row, ApiErr.notFound('record', recordId)));
	});
}

/** Fails with not_found when the entry isn't in the collection. */
export async function deleteVaultEntry(
	collection: VaultCollection,
	recordId: string,
): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {count} = $(
			await wrapDb(() => db.vaultEntry.deleteMany({where: {...collection, id: recordId}})),
		);
		if (count === 0) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
	});
}

// A record from before the vault had one collection: an address, a payment card or a note, until
// the api turns it into an entry as it starts.
export type OldVaultRecord = {id: string; collectionId: string; values: string};

export async function listOldVaultRecords(): Promise<Result<OldVaultRecord[], ApiError>> {
	return wrapDb(() =>
		db.vaultEntry.findMany({
			where: {collectionId: {not: 'entries'}},
			select: {id: true, collectionId: true, values: true},
		}),
	);
}

/**
 * The record as an entry, or gone where `values` is null. Only while it is still the old record,
 * so servers starting at once change it once; `Ok(false)` when another already had.
 */
export async function replaceOldVaultRecord(
	record: OldVaultRecord,
	values: string | null,
): Promise<Result<boolean, ApiError>> {
	const where = {id: record.id, collectionId: record.collectionId};
	if (values === null) {
		return (await wrapDb(() => db.vaultEntry.deleteMany({where}))).map(({count}) => count > 0);
	}

	return (
		await wrapDb(() => db.vaultEntry.updateMany({where, data: {collectionId: 'entries', values}}))
	).map(({count}) => count > 0);
}
