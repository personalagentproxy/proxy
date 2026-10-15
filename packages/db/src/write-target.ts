import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/** Where a person last wrote to a collection from the home page: a connection, and in it a calendar. */
export type WriteTargetRow = {connectionId: string; parent: string | null};

/** `Ok(null)` until the person first writes to the collection, or once its connection is gone. */
export async function getWriteTarget(
	userId: string,
	collectionId: string,
): Promise<Result<WriteTargetRow | null, ApiError>> {
	return wrapDb(() =>
		db.writeTarget.findUnique({
			where: {userId_collectionId: {userId, collectionId}},
			select: {connectionId: true, parent: true},
		}),
	);
}

export async function saveWriteTarget(data: {
	userId: string;
	collectionId: string;
	connectionId: string;
	parent: string | null;
}): Promise<Result<void, ApiError>> {
	const {userId, collectionId, connectionId, parent} = data;
	return wrapDb(async () => {
		await db.writeTarget.upsert({
			where: {userId_collectionId: {userId, collectionId}},
			create: data,
			update: {connectionId, parent},
		});
	});
}
