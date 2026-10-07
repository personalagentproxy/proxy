import {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {createInfoRecord, deleteInfoRecord, getInfoRecord, listInfoRecords, updateInfoRecord, type InfoRecordRow} from '@proxy/db/info';

import {decryptSecret, encryptSecret} from '../utils/secret-crypto';
import type {Connector, DataRecord, RecordTarget, RecordValues} from './connector';

const storedValuesSchema = z.record(z.string(), z.string());

function infoCollection(target: RecordTarget) {
	return {connectionId: target.connection.id, collectionId: target.collection.id};
}

function encryptValues(values: RecordValues): Result<string, ApiError> {
	return encryptSecret(JSON.stringify(values));
}

function toRecord(row: InfoRecordRow): Result<DataRecord, ApiError> {
	return Do<DataRecord, ApiError>(($) => {
		const json = $(decryptSecret(row.values));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		const values = $(parseSchema(storedValuesSchema, parsed));
		return {id: row.id, values, updatedAt: row.updatedAt.toISOString()};
	});
}

/** Information lives in Personal Agent Proxy: each record's values are stored as encrypted JSON. */
export const infoConnector: Connector = {
	// Few enough to search in memory, after decrypting, and to list on one page.
	list: (target, query) =>
		Do(async ($) => {
			const rows = $(await listInfoRecords(infoCollection(target)));
			const records = rows.map((row) => $(toRecord(row)));
			const search = query.search?.toLowerCase();
			const matching = search ? records.filter((record) => Object.values(record.values).some((value) => value.toLowerCase().includes(search))) : records;
			return {records: matching, nextPage: null};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const row = $(await getInfoRecord(infoCollection(target), recordId));
			return $(toRecord($(requirePresent(row, ApiErr.notFound('record', recordId)))));
		}),
	create: (target, values) =>
		Do(async ($) => {
			const row = $(await createInfoRecord(infoCollection(target), $(encryptValues(values))));
			return $(toRecord(row));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const row = $(await updateInfoRecord(infoCollection(target), recordId, $(encryptValues(values))));
			return $(toRecord(row));
		}),
	remove: (target, recordId) => deleteInfoRecord(infoCollection(target), recordId),
};
