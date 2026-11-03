import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {listOldVaultRecords, replaceOldVaultRecord, type OldVaultRecord} from '@proxy/db/vault';

import {worthRetrying} from '../data-migrations/retry';
import {log, serializeError} from '../observability/log';
import type {RecordValues} from './connector';
import {decryptValues, encryptValues} from './vault-connector';

/**
 * Turning what Information kept into vault entries, as a data migration (`data-migrations/run.ts`),
 * since only the api can read them (the names and access moved in migration
 * `v023_rename_information_to_vault`): an address becomes an Address entry titled by its label,
 * written out a line at a time; a note a Text entry under its title; a payment card is deleted, as
 * the vault keeps none. Each record once, however many servers start at once
 * (`replaceOldVaultRecord`), and tried again on the next start where any failed for a reason it
 * might not meet (`worthRetrying`); one that can't be read stays as it is, logged.
 */

/** What an old record becomes: an entry's values, or null to delete it. Exported for its tests. */
export function entryFrom(collectionId: string, values: RecordValues): RecordValues | null {
	const field = (key: string) => values[key]?.trim() ?? '';
	if (collectionId === 'addresses') {
		const lines = [field('name'), field('street'), `${field('postalCode')} ${field('city')}`.trim(), field('country')];
		return {title: field('label') || 'Address', type: 'Address', content: lines.filter(Boolean).join('\n')};
	}

	if (collectionId === 'notes') {
		return {title: field('title') || 'Note', type: 'Text', content: field('body')};
	}

	// A payment card, the one other collection there was.
	return null;
}

function convert(record: OldVaultRecord): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		const entry = entryFrom(record.collectionId, $(decryptValues(record.values)));
		const values = entry ? $(encryptValues(entry)) : null;
		return $(await replaceOldVaultRecord(record, values));
	});
}

/**
 * Converts every record from before the vault, logging each; an error when listing them failed, or
 * converting any did for a reason the next start might not meet, so the data migration is tried
 * again then.
 */
export async function convertOldVaultRecords(): Promise<Result<void, ApiError>> {
	const records = await listOldVaultRecords();
	if (records.isErr()) {
		log.error('Listing records to turn into vault entries failed', 'cause' in records.error ? serializeError(records.error.cause) : {kind: records.error.kind});
		return Err(records.error);
	}

	let failed = 0;
	for (const record of records.value) {
		const converted = await convert(record);
		if (converted.isErr()) {
			const details = {
				recordId: record.id,
				collectionId: record.collectionId,
				kind: converted.error.kind,
				...('cause' in converted.error ? serializeError(converted.error.cause) : {}),
			};
			if (!worthRetrying(converted.error)) {
				log.error('A record can’t be turned into a vault entry, and stays as it is', details);
				continue;
			}
			failed += 1;
			log.warn('Turning a record into a vault entry failed, to be tried again on the next start', details);
			continue;
		}
		if (converted.value) {
			log.info('Turned a record into a vault entry', {recordId: record.id, collectionId: record.collectionId});
		}
	}
	if (failed > 0) {
		return Err(ApiErr.internalError(new Error(`Turning ${failed} records into vault entries failed`)));
	}
	return Ok(undefined);
}
