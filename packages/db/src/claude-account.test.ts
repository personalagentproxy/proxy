import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	deleteClaudeAccount,
	getClaudeAccount,
	markClaudeAccountFailed,
	setClaudeAccountUsage,
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

const noUsage = {
	usageFiveHourUtilization: null,
	usageFiveHourResetsAt: null,
	usageSevenDayUtilization: null,
	usageSevenDayResetsAt: null,
	usageReadAt: null,
};

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

	test('a member starts with none, and marking or reading usage on none does nothing', async () => {
		expect(unwrap(await getClaudeAccount(userId))).toBeNull();
		unwrap(await markClaudeAccountFailed(userId, 'refused'));
		unwrap(await setClaudeAccountUsage(userId, {readAt: new Date()}));
		expect(unwrap(await getClaudeAccount(userId))).toBeNull();
	});

	test('connecting stores the kind, the credential and the expiry as given, and connecting again replaces them and clears the failure and the usage', async () => {
		const expiresAt = new Date('2027-11-09T12:00:00.000Z');
		const first = unwrap(
			await upsertClaudeAccount(userId, {kind: 'setup_token', credential: 'enc:one', expiresAt}),
		);
		expect(first).toMatchObject({
			userId,
			kind: 'setup_token',
			credential: 'enc:one',
			expiresAt,
			failedAt: null,
			failure: null,
			...noUsage,
		});

		unwrap(await markClaudeAccountFailed(userId, 'refused'));
		unwrap(
			await setClaudeAccountUsage(userId, {
				fiveHour: {utilization: 0.4, resetsAt: new Date('2026-11-10T15:00:00.000Z')},
				readAt: new Date('2026-11-10T12:00:00.000Z'),
			}),
		);
		const failed = unwrap(await getClaudeAccount(userId));
		expect(failed?.failure).toBe('refused');
		expect(failed?.failedAt).toBeInstanceOf(Date);
		expect(failed?.usageFiveHourUtilization).toBe(0.4);

		const second = unwrap(
			await upsertClaudeAccount(userId, {kind: 'api_key', credential: 'enc:two'}),
		);
		expect(second.id).toBe(first.id);
		expect(second).toMatchObject({
			kind: 'api_key',
			credential: 'enc:two',
			expiresAt: null,
			failedAt: null,
			failure: null,
			...noUsage,
		});
	});

	test('usage is kept window by window: one left out keeps what was known, and the read time is the turn’s', async () => {
		unwrap(await upsertClaudeAccount(userId, {kind: 'setup_token', credential: 'enc:token'}));
		const firstRead = new Date('2026-11-10T12:00:00.000Z');
		const fiveHourReset = new Date('2026-11-10T15:00:00.000Z');
		const sevenDayReset = new Date('2026-11-14T00:00:00.000Z');

		unwrap(
			await setClaudeAccountUsage(userId, {
				fiveHour: {utilization: 0.37, resetsAt: fiveHourReset},
				sevenDay: {utilization: 0.12, resetsAt: sevenDayReset},
				readAt: firstRead,
			}),
		);
		expect(unwrap(await getClaudeAccount(userId))).toMatchObject({
			usageFiveHourUtilization: 0.37,
			usageFiveHourResetsAt: fiveHourReset,
			usageSevenDayUtilization: 0.12,
			usageSevenDayResetsAt: sevenDayReset,
			usageReadAt: firstRead,
		});

		const secondRead = new Date('2026-11-10T13:00:00.000Z');
		unwrap(
			await setClaudeAccountUsage(userId, {
				fiveHour: {utilization: 0.5, resetsAt: null},
				readAt: secondRead,
			}),
		);
		expect(unwrap(await getClaudeAccount(userId))).toMatchObject({
			usageFiveHourUtilization: 0.5,
			usageFiveHourResetsAt: null,
			usageSevenDayUtilization: 0.12,
			usageSevenDayResetsAt: sevenDayReset,
			usageReadAt: secondRead,
		});
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
