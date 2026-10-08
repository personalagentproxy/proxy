import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/** Keeps the existing value when the key already exists, so concurrent first boots agree. */
export async function getOrCreateInstanceMetaValue(
	key: string,
	value: string,
): Promise<Result<string, ApiError>> {
	return (
		await wrapDb(() =>
			db.instanceMeta.upsert({
				where: {key},
				create: {key, value},
				update: {},
				select: {value: true},
			}),
		)
	).map((row) => row.value);
}
