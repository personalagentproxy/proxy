import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type InstanceMetaTaskOutcome = 'completed' | 'failed' | 'skipped';

type AdvisoryLockRow = {locked: boolean};

/** Keeps the existing value when the key already exists, so concurrent first boots agree. */
export async function getOrCreateInstanceMetaValue(
	key: string,
	value: string,
): Promise<Result<string, ApiError>> {
	return (
		await wrapDb(
			() =>
				db.instanceMeta.upsert({
					where: {key},
					create: {key, value},
					update: {},
					select: {value: true},
				}),
			{logFailure: false},
		)
	).map((row) => row.value);
}

/**
 * Runs one installation-wide task while holding a transaction-scoped Postgres lock. A second api
 * process skips immediately, and the timestamp is stored only after the task succeeds.
 */
export async function runInstanceMetaTaskIfStale(
	key: string,
	value: string,
	staleBefore: string,
	task: () => Promise<boolean>,
): Promise<Result<InstanceMetaTaskOutcome, ApiError>> {
	return wrapDb(
		() =>
			db.$transaction(
				async (transaction) => {
					const [lock] = await transaction.$queryRaw<AdvisoryLockRow[]>`
						SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS "locked"
					`;
					if (!lock?.locked) {
						return 'skipped';
					}

					const existing = await transaction.instanceMeta.findUnique({
						where: {key},
						select: {value: true},
					});
					if (existing && existing.value >= staleBefore) {
						return 'skipped';
					}

					if (!(await task())) {
						return 'failed';
					}

					await transaction.instanceMeta.upsert({
						where: {key},
						create: {key, value},
						update: {value},
					});
					return 'completed';
				},
				{maxWait: 1_000, timeout: 10_000},
			),
		{logFailure: false},
	);
}
