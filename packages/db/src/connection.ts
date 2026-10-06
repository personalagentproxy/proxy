import type {Access} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type ConnectionRow = {
	id: string;
	integrationId: string;
	account: string;
	createdAt: Date;
	defaults: Array<{collectionId: string; access: Access}>;
};

// Never the credential: only `getConnectionCredential` reads it.
const connectionSelect = {
	id: true,
	integrationId: true,
	account: true,
	createdAt: true,
	defaults: {select: {collectionId: true, access: true}},
} as const;

export async function listConnections(orgId: string): Promise<Result<ConnectionRow[], ApiError>> {
	return wrapDb(() =>
		db.connection.findMany({
			where: {orgId},
			select: connectionSelect,
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/** `Ok(null)` means no such connection in the organization. */
export async function getConnection(
	orgId: string,
	connectionId: string,
): Promise<Result<ConnectionRow | null, ApiError>> {
	return wrapDb(() =>
		db.connection.findFirst({where: {id: connectionId, orgId}, select: connectionSelect}),
	);
}

/** `credential` is already encrypted; this package never sees it in the clear. */
export async function createConnection(data: {
	orgId: string;
	integrationId: string;
	account: string;
	credential: string;
}): Promise<Result<ConnectionRow, ApiError>> {
	return wrapDb(() => db.connection.create({data, select: connectionSelect}));
}

/** `Ok(false)` means no such connection in the organization. Its defaults go with it. */
export async function deleteConnection(
	orgId: string,
	connectionId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.connection.deleteMany({where: {id: connectionId, orgId}}))).map(
		({count}) => count > 0,
	);
}

/** The caller has checked that the connection belongs to the organization. */
export async function setConnectionDefault(data: {
	connectionId: string;
	collectionId: string;
	access: Access;
}): Promise<Result<void, ApiError>> {
	const {connectionId, collectionId, access} = data;
	return (
		await wrapDb(() =>
			db.connectionDefault.upsert({
				where: {connectionId_collectionId: {connectionId, collectionId}},
				create: data,
				update: {access},
			}),
		)
	).map(() => undefined);
}
