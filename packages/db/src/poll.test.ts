import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {claimPoll, deletePoll, ensurePoll, finishPoll, listPolls, renewPollLease} from './poll';

// What polling writes, against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/poll.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

describe.skipIf(!databaseUrl)('polling, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `poll-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Poll test', slug: `poll-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
	});

	afterAll(async () => {
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
		await db.$disconnect();
	});

	test('a poll is had once per connection and collection, claimed when due with a lease, finished with where it left off, and deleted', async () => {
		const a = unwrap(await ensurePoll({orgId, connectionId: 'conn-a', collectionId: 'emails'}));
		expect(
			unwrap(await ensurePoll({orgId, connectionId: 'conn-a', collectionId: 'emails'})).id,
		).toBe(a.id);
		const b = unwrap(await ensurePoll({orgId, connectionId: 'conn-b', collectionId: 'emails'}));
		expect(a).toMatchObject({cursor: null, claimedBy: null, lastPolledAt: null, lastError: null});
		expect(unwrap(await listPolls(orgId)).map((poll) => poll.connectionId)).toEqual([
			'conn-a',
			'conn-b',
		]);

		// Due now, for a first look; the earliest due first, and nothing while both are claimed.
		const first = unwrap(await claimPoll('worker-a', 60_000));
		expect(first?.id).toBe(a.id);
		expect(first?.claimedBy).toBe('worker-a');
		expect(unwrap(await claimPoll('worker-a', 60_000))?.id).toBe(b.id);
		expect(unwrap(await claimPoll('worker-b', 60_000))).toBeNull();
		expect(unwrap(await renewPollLease(a.id, 'worker-a', 60_000))).toBe(true);
		expect(unwrap(await renewPollLease(a.id, 'worker-b', 60_000))).toBe(false);

		const later = new Date(Date.now() + 600_000);
		expect(
			unwrap(await finishPoll(a.id, 'worker-a', {cursor: '1:10', nextAt: later, error: null})),
		).toBe(true);
		// Not the worker's any more.
		expect(
			unwrap(await finishPoll(a.id, 'worker-a', {cursor: '1:11', nextAt: later, error: null})),
		).toBe(false);
		const finished = unwrap(await listPolls(orgId)).find((poll) => poll.id === a.id);
		expect(finished).toMatchObject({
			cursor: '1:10',
			claimedBy: null,
			lastError: null,
			nextAt: later,
		});
		expect(finished?.lastPolledAt).not.toBeNull();
		expect(
			unwrap(
				await finishPoll(b.id, 'worker-a', {
					cursor: null,
					nextAt: later,
					error: 'The mailbox could not be reached',
				}),
			),
		).toBe(true);
		expect(unwrap(await listPolls(orgId)).find((poll) => poll.id === b.id)?.lastError).toBe(
			'The mailbox could not be reached',
		);

		// Nothing due until then; a lease run out is claimable again.
		expect(unwrap(await claimPoll('worker-c', 60_000))).toBeNull();
		await db.connectionPoll.update({
			where: {id: a.id},
			data: {nextAt: new Date(Date.now() - 1000)},
		});
		const again = unwrap(await claimPoll('worker-c', 1));
		expect(again?.id).toBe(a.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(unwrap(await claimPoll('worker-d', 60_000))?.id).toBe(a.id);

		unwrap(await deletePoll(a.id));
		unwrap(await deletePoll(b.id));
		expect(unwrap(await listPolls(orgId))).toEqual([]);
	});
});
