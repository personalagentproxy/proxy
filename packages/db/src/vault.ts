import type {Prisma} from '@prisma/client';
import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, wrapDb} from '@proxy/utils';

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

/**
 * What a write checks of the collection's entries as they are when it writes: the others' rows,
 * read with the collection's other checked writes held off until this one is done, so two at once
 * never both pass. An error stops the write.
 */
export type VaultEntriesCheck = (rows: VaultEntryRow[]) => Result<void, ApiError>;

type Tx = Prisma.TransactionClient;

// Every checked write of the collection, one after the other: a lock on a key made of the
// collection, held until the transaction ends, as the collection has no row of its own to take.
async function checkEntries(
	tx: Tx,
	collection: VaultCollection,
	check: VaultEntriesCheck,
	recordId: string | null,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`vault:${collection.connectionId}:${collection.collectionId}`}::text, 0))`;
	const rows = await tx.vaultEntry.findMany({
		where: {...collection, ...(recordId === null ? {} : {id: {not: recordId}})},
		select: vaultEntrySelect,
	});
	const checked = check(rows);
	if (checked.isErr()) {
		throw checked.error;
	}
}

export async function createVaultEntry(
	collection: VaultCollection,
	values: string,
	check?: VaultEntriesCheck,
): Promise<Result<VaultEntryRow, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (check) {
				await checkEntries(tx, collection, check, null);
			}
			return tx.vaultEntry.create({data: {...collection, values}, select: vaultEntrySelect});
		}),
	);
}

/** Fails with not_found when the entry isn't in the collection. */
export async function updateVaultEntry(
	collection: VaultCollection,
	recordId: string,
	values: string,
	check?: VaultEntriesCheck,
): Promise<Result<VaultEntryRow, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (check) {
				await checkEntries(tx, collection, check, recordId);
			}
			const {count} = await tx.vaultEntry.updateMany({
				where: {...collection, id: recordId},
				data: {values},
			});
			if (count === 0) {
				throw ApiErr.notFound('record', recordId);
			}
			const row = await tx.vaultEntry.findFirst({
				where: {...collection, id: recordId},
				select: vaultEntrySelect,
			});
			if (!row) {
				throw ApiErr.notFound('record', recordId);
			}
			return row;
		}),
	);
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

// A record from before the vault had its entries: an address, a payment card or a note, until the
// api turns it into an entry as it starts. A secret is the vault's own, as an entry is.
export type OldVaultRecord = {id: string; collectionId: string; values: string};

export async function listOldVaultRecords(): Promise<Result<OldVaultRecord[], ApiError>> {
	return wrapDb(() =>
		db.vaultEntry.findMany({
			where: {collectionId: {notIn: ['entries', 'secrets']}},
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
