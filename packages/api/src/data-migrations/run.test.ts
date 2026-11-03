import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const hasInstanceMetaKey = mock();
const setInstanceMetaValue = mock();
mock.module('@proxy/db/instance-meta', () => ({hasInstanceMetaKey, setInstanceMetaValue}));

mock.module('../connections/take-over-custom', () => ({takeOverCustomConnections: mock()}));
mock.module('../records/vault-entries', () => ({convertOldVaultRecords: mock()}));

const error = mock();
mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error},
	serializeError: mock(() => ({})),
}));

const {DATA_MIGRATIONS, runDataMigrations} = await import('./run');

const done = new Set<string>();

beforeEach(() => {
	mock.clearAllMocks();
	done.clear();
	hasInstanceMetaKey.mockImplementation(async (key: string) => Ok(done.has(key)));
	setInstanceMetaValue.mockImplementation(async (key: string) => {
		done.add(key);
		return Ok(undefined);
	});
});

describe('runDataMigrations', () => {
	test('runs each migration not yet noted, and notes it with when it finished', async () => {
		done.add('data_migration:first');
		const first = mock(async () => Ok(undefined));
		const second = mock(async () => Ok(undefined));

		await runDataMigrations([
			{id: 'first', run: first},
			{id: 'second', run: second},
		]);

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
		expect(setInstanceMetaValue).toHaveBeenCalledTimes(1);
		const [key, value] = setInstanceMetaValue.mock.calls[0] ?? [];
		expect(key).toBe('data_migration:second');
		expect(new Date(String(value)).toISOString()).toBe(String(value));
	});

	test('a migration that fails is logged and left unnoted, to run again on the next start', async () => {
		const failing = mock(async () => Err(ApiErr.internalError(new Error('down'))));

		await runDataMigrations([{id: 'failing', run: failing}]);
		await runDataMigrations([{id: 'failing', run: failing}]);

		expect(failing).toHaveBeenCalledTimes(2);
		expect(setInstanceMetaValue).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(2);
	});

	test("a migration isn't run when whether it ran can't be told", async () => {
		hasInstanceMetaKey.mockImplementation(async () => Err(ApiErr.dbError(new Error('no database'))));
		const migration = mock(async () => Ok(undefined));

		await runDataMigrations([{id: 'unknown', run: migration}]);

		expect(migration).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
	});

	test('one failing leaves the others to run and be noted', async () => {
		const failing = mock(async () => Err(ApiErr.internalError(new Error('down'))));
		const working = mock(async () => Ok(undefined));

		await runDataMigrations([
			{id: 'failing', run: failing},
			{id: 'working', run: working},
		]);

		expect([...done]).toEqual(['data_migration:working']);
	});

	test('every migration has an id of its own', () => {
		const ids = DATA_MIGRATIONS.map((migration) => migration.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
