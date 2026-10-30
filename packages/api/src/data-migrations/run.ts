import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {hasInstanceMetaKey, setInstanceMetaValue} from '@proxy/db/instance-meta';

import {takeOverCustomConnections} from '../connections/take-over-custom';
import {log, serializeError} from '../observability/log';
import {convertOldVaultRecords} from '../records/vault-entries';

/**
 * Changes to the data that only the api can make, as reading a credential takes its key, run once
 * per instance after it starts listening rather than on every start. One that finishes is noted in
 * `InstanceMeta` under its id, with when; one that fails is logged and left unnoted, so the next
 * start tries it again, for what might go through then alone (`retry.ts`). Each has to be safe to
 * run twice, as two servers starting at once both do.
 *
 * Once hosted and self-hosted instances have all started past one, its entry here and the code it
 * calls can be deleted.
 */
export type DataMigration = {id: string; run: () => Promise<Result<void, ApiError>>};

export const DATA_MIGRATIONS: DataMigration[] = [
	{id: 'take-over-custom-connections', run: takeOverCustomConnections},
	{id: 'convert-old-vault-records', run: convertOldVaultRecords},
];

function metaKey(id: string): string {
	return `data_migration:${id}`;
}

function errorDetails(error: ApiError) {
	return 'cause' in error ? serializeError(error.cause) : {kind: error.kind};
}

async function runOne(migration: DataMigration): Promise<void> {
	const done = await hasInstanceMetaKey(metaKey(migration.id));
	if (done.isErr()) {
		log.error('Checking a data migration failed', {id: migration.id, ...errorDetails(done.error)});
		return;
	}
	if (done.value) {
		return;
	}
	const ran = await migration.run();
	if (ran.isErr()) {
		log.error('A data migration failed, to be tried again on the next start', {id: migration.id, ...errorDetails(ran.error)});
		return;
	}
	const noted = await setInstanceMetaValue(metaKey(migration.id), new Date().toISOString());
	if (noted.isErr()) {
		log.error('Noting a data migration as done failed', {id: migration.id, ...errorDetails(noted.error)});
		return;
	}
	log.info('Ran a data migration', {id: migration.id});
}

/** Runs every data migration not yet noted as done, side by side. */
export async function runDataMigrations(migrations: DataMigration[] = DATA_MIGRATIONS): Promise<void> {
	await Promise.all(migrations.map(runOne));
}
