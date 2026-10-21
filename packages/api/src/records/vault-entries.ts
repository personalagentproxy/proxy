import {type Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {listOldVaultRecords, replaceOldVaultRecord, type OldVaultRecord} from '@proxy/db/vault';

import {log, serializeError} from '../observability/log';
import type {RecordValues} from './connector';
import {decryptValues, encryptValues} from './vault-connector';

/**
 * Turning what Information kept into vault entries, every time the api starts, since only the api
 * can read them (the names and access moved in migration `v022_rename_information_to_vault`): an
 * address becomes an Address entry titled by its label, written out a line at a time; a note a
 * Text entry under its title; a payment card is deleted, as the vault keeps none. Each record once,
 * however many servers start at once (`replaceOldVaultRecord`), and tried again on the next start
 * where it failed.
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

/** Converts every record from before the vault, logging each. */
export async function convertOldVaultRecords(): Promise<void> {
	const records = await listOldVaultRecords();
	if (records.isErr()) {
		log.error('Listing records to turn into vault entries failed', 'cause' in records.error ? serializeError(records.error.cause) : {kind: records.error.kind});
		return;
	}

	for (const record of records.value) {
		const converted = await convert(record);
		if (converted.isErr()) {
			log.warn('Turning a record into a vault entry failed', {
				recordId: record.id,
				collectionId: record.collectionId,
				kind: converted.error.kind,
				...('cause' in converted.error ? serializeError(converted.error.cause) : {}),
			});
			continue;
		}
		if (converted.value) {
			log.info('Turned a record into a vault entry', {recordId: record.id, collectionId: record.collectionId});
		}
	}
}
