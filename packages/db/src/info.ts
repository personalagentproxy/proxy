import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent, wrapDb} from '@proxy/utils';

import {db} from '.';

// `values` is encrypted JSON; this package never sees it in the clear.
export type InfoRecordRow = {id: string; values: string; updatedAt: Date};

export type InfoCollection = {connectionId: string; collectionId: string};

const infoRecordSelect = {id: true, values: true, updatedAt: true} as const;

export async function listInfoRecords(
	collection: InfoCollection,
): Promise<Result<InfoRecordRow[], ApiError>> {
	return wrapDb(() =>
		db.infoRecord.findMany({
			where: collection,
			select: infoRecordSelect,
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/** `Ok(null)` means no such record in the collection. */
export async function getInfoRecord(
	collection: InfoCollection,
	recordId: string,
): Promise<Result<InfoRecordRow | null, ApiError>> {
	return wrapDb(() =>
		db.infoRecord.findFirst({where: {...collection, id: recordId}, select: infoRecordSelect}),
	);
}

export async function createInfoRecord(
	collection: InfoCollection,
	values: string,
): Promise<Result<InfoRecordRow, ApiError>> {
	return wrapDb(() =>
		db.infoRecord.create({data: {...collection, values}, select: infoRecordSelect}),
	);
}

/** Fails with not_found when the record isn't in the collection. */
export async function updateInfoRecord(
	collection: InfoCollection,
	recordId: string,
	values: string,
): Promise<Result<InfoRecordRow, ApiError>> {
	return Do(async ($) => {
		const {count} = $(
			await wrapDb(() =>
				db.infoRecord.updateMany({where: {...collection, id: recordId}, data: {values}}),
			),
		);
		if (count === 0) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}

		const row = $(await getInfoRecord(collection, recordId));
		return $(requirePresent(row, ApiErr.notFound('record', recordId)));
	});
}

/** Fails with not_found when the record isn't in the collection. */
export async function deleteInfoRecord(
	collection: InfoCollection,
	recordId: string,
): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {count} = $(
			await wrapDb(() => db.infoRecord.deleteMany({where: {...collection, id: recordId}})),
		);
		if (count === 0) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
	});
}
