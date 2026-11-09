import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	deleteClaudeAccount,
	getClaudeAccount,
	markClaudeAccountFailed,
	setClaudeAccountProfile,
	updateClaudeAccountLocked,
	upsertClaudeAccount,
} from './claude-account';

// A member's Claude account, against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/claude-account.test.ts` from this
// package. Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and
// this is skipped. Everything made here is one user's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

describe.skipIf(!databaseUrl)('a Claude account, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `claude-account-test-${stamp}@example.test`}});
		userId = user.id;
	});

	afterAll(async () => {
		await db.user.deleteMany({where: {id: userId}});
	});

	test('a member starts with none', async () => {
		expect(unwrap(await getClaudeAccount(userId))).toBeNull();
		expect(
			unwrap(await updateClaudeAccountLocked(userId, async () => ({update: null, value: 'ran'}))),
		).toBeNull();
		expect(
			unwrap(
				await setClaudeAccountProfile(userId, {email: 'a@example.com', subscriptionType: 'max'}),
			),
		).toBe(false);
	});

	test('connecting stores the kind and the credential as given, and connecting again replaces them and clears the failure', async () => {
		const expiresAt = new Date('2026-11-09T12:00:00.000Z');
		const first = unwrap(
			await upsertClaudeAccount(userId, {kind: 'oauth', credential: 'enc:one', expiresAt}),
		);
		expect(first).toMatchObject({
			userId,
			kind: 'oauth',
			credential: 'enc:one',
			expiresAt,
			email: null,
			failedAt: null,
			failure: null,
		});

		unwrap(await markClaudeAccountFailed(userId, 'refused'));
		unwrap(
			await setClaudeAccountProfile(userId, {email: 'a@example.com', subscriptionType: 'max'}),
		);
		const failed = unwrap(await getClaudeAccount(userId));
		expect(failed?.failure).toBe('refused');
		expect(failed?.failedAt).toBeInstanceOf(Date);
		expect(failed?.email).toBe('a@example.com');
		expect(failed?.subscriptionType).toBe('max');

		const second = unwrap(
			await upsertClaudeAccount(userId, {kind: 'api_key', credential: 'enc:two'}),
		);
		expect(second.id).toBe(first.id);
		expect(second).toMatchObject({
			kind: 'api_key',
			credential: 'enc:two',
			expiresAt: null,
			email: null,
			subscriptionType: null,
			failedAt: null,
			failure: null,
		});
	});

	test('a locked update hands the row to the function and writes what it returns', async () => {
		unwrap(
			await upsertClaudeAccount(userId, {
				kind: 'oauth',
				credential: 'enc:old',
				expiresAt: new Date('2026-11-09T12:00:00.000Z'),
			}),
		);
		const refreshedAt = new Date('2026-11-09T11:58:00.000Z');
		const newExpiry = new Date('2026-11-09T20:00:00.000Z');

		const seen = unwrap(
			await updateClaudeAccountLocked(userId, async (row) => ({
				update: {credential: 'enc:new', expiresAt: newExpiry, lastRefreshedAt: refreshedAt},
				value: row.credential,
			})),
		);
		expect(seen).toBe('enc:old');
		const after = unwrap(await getClaudeAccount(userId));
		expect(after).toMatchObject({
			credential: 'enc:new',
			expiresAt: newExpiry,
			lastRefreshedAt: refreshedAt,
		});

		const failedAt = new Date('2026-11-09T12:30:00.000Z');
		unwrap(
			await updateClaudeAccountLocked(userId, async () => ({
				update: {failedAt, failure: 'gone'},
				value: undefined,
			})),
		);
		expect(unwrap(await getClaudeAccount(userId))).toMatchObject({
			credential: 'enc:new',
			failedAt,
			failure: 'gone',
		});

		unwrap(await updateClaudeAccountLocked(userId, async () => ({update: null, value: undefined})));
		expect(unwrap(await getClaudeAccount(userId))).toMatchObject({
			credential: 'enc:new',
			failedAt,
			failure: 'gone',
		});
	});

	test('two locked updates run one after the other, the second seeing what the first wrote', async () => {
		unwrap(
			await upsertClaudeAccount(userId, {kind: 'oauth', credential: 'enc:0', expiresAt: null}),
		);
		const seen: string[] = [];
		const update = (label: string) =>
			updateClaudeAccountLocked(userId, async (row) => {
				seen.push(`${label}:${row.credential}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
				return {
					update: {credential: `enc:${label}`, expiresAt: null, lastRefreshedAt: new Date()},
					value: undefined,
				};
			});
		await Promise.all([update('a'), update('b')]);
		expect(seen.length).toBe(2);
		// Whichever went first, the other read the credential it wrote, not the one both started from.
		expect(seen.filter((entry) => entry.endsWith(':enc:0')).length).toBe(1);
	});

	test('disconnecting deletes the account, and deleting the user takes it with them', async () => {
		unwrap(await upsertClaudeAccount(userId, {kind: 'setup_token', credential: 'enc:token'}));
		unwrap(await deleteClaudeAccount(userId));
		expect(unwrap(await getClaudeAccount(userId))).toBeNull();
		unwrap(await deleteClaudeAccount(userId));

		unwrap(await upsertClaudeAccount(userId, {kind: 'setup_token', credential: 'enc:token'}));
		await db.user.delete({where: {id: userId}});
		expect(await db.claudeAccount.count({where: {userId}})).toBe(0);
	});
});
