import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {db} from '.';
import {
	createVaultEntry,
	listVaultEntries,
	updateVaultEntry,
	type VaultCollection,
	type VaultEntriesCheck,
} from './vault';

// A vault's checked writes, against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/vault.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end. The values stand for
// encrypted ones: this package never reads them, only a check does.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

// No other row holds the value, as the api checks a secret's name.
function valueFree(value: string): VaultEntriesCheck {
	return (rows) => {
		if (rows.some((row) => row.values === value)) {
			return Err(ApiErr.conflict(`${value} is taken`));
		}
		return Ok(undefined);
	};
}

describe.skipIf(!databaseUrl)('vault, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let collection: VaultCollection = {connectionId: '', collectionId: 'secrets'};

	beforeAll(async () => {
		const user = await db.user.create({
			data: {email: `vault-test-${stamp}@example.test`, name: 'Dana'},
		});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Vault test', slug: `vault-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		const connection = await db.connection.create({
			data: {orgId, integrationId: 'vault', ownerUserId: userId, account: 'Vault test'},
		});
		collection = {connectionId: connection.id, collectionId: 'secrets'};
	});

	afterAll(async () => {
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
	});

	test('checked writes at once are checked one after the other, so only one takes a value', async () => {
		const results = await Promise.all(
			Array.from({length: 5}, () => createVaultEntry(collection, 'API_KEY', valueFree('API_KEY'))),
		);

		expect(results.filter((result) => result.isOk())).toHaveLength(1);
		expect(
			results.filter((result) => result.isErr()).map((result) => result.unwrapErr().kind),
		).toEqual(['conflict', 'conflict', 'conflict', 'conflict']);
		expect(unwrap(await listVaultEntries(collection))).toHaveLength(1);
	});

	test('an update is checked against the others alone, and a refused one changes nothing', async () => {
		const own = unwrap(await createVaultEntry(collection, 'OWN_KEY', valueFree('OWN_KEY')));

		expect(
			unwrap(await updateVaultEntry(collection, own.id, 'OWN_KEY', valueFree('OWN_KEY'))).id,
		).toBe(own.id);
		expect(
			(await updateVaultEntry(collection, own.id, 'API_KEY', valueFree('API_KEY'))).unwrapErr()
				.kind,
		).toBe('conflict');
		expect(
			unwrap(await listVaultEntries(collection))
				.map((row) => row.values)
				.sort(),
		).toEqual(['API_KEY', 'OWN_KEY']);
	});

	test('an update of an entry not in the collection is not found', async () => {
		const result = await updateVaultEntry(collection, 'missing', 'X', valueFree('X'));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});
