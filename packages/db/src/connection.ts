import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type ConnectionRow = {
	id: string;
	integrationId: string;
	account: string;
	createdAt: Date;
	// The actions agents get by default, one per row.
	defaults: Array<{actionId: string}>;
};

// Never the credential: only `getConnectionWithCredential` reads it.
const connectionSelect = {
	id: true,
	integrationId: true,
	account: true,
	createdAt: true,
	defaults: {select: {actionId: true}},
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

/** The connection with its encrypted credential, for the code that talks to the provider. */
export async function getConnectionWithCredential(
	orgId: string,
	connectionId: string,
): Promise<Result<(ConnectionRow & {credential: string | null}) | null, ApiError>> {
	return wrapDb(() =>
		db.connection.findFirst({
			where: {id: connectionId, orgId},
			select: {...connectionSelect, credential: true},
		}),
	);
}

/**
 * `credential` is already encrypted; this package never sees it in the clear. `defaults` are the
 * actions agents get from the start, none when left out.
 */
export async function createConnection(data: {
	orgId: string;
	integrationId: string;
	account: string;
	credential: string;
	defaults?: string[];
}): Promise<Result<ConnectionRow, ApiError>> {
	const {defaults = [], ...connection} = data;
	return wrapDb(() =>
		db.connection.create({
			data: {...connection, defaults: {create: defaults.map((actionId) => ({actionId}))}},
			select: connectionSelect,
		}),
	);
}

/**
 * Replaces a connection's encrypted credential, as when Granola hands out new tokens. With
 * `previous`, only while the credential is still that one, so two servers refreshing at once
 * don't overwrite each other: `Ok(false)` when it had already changed.
 */
export async function updateConnectionCredential(data: {
	connectionId: string;
	credential: string;
	previous?: string;
}): Promise<Result<boolean, ApiError>> {
	const {connectionId, credential, previous} = data;
	const where =
		previous === undefined ? {id: connectionId} : {id: connectionId, credential: previous};
	return (await wrapDb(() => db.connection.updateMany({where, data: {credential}}))).map(
		({count}) => count > 0,
	);
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

/**
 * Turns default actions of a connection on or off; actions left out stay as they are. The caller
 * has checked that the connection belongs to the organization and the actions to its integration.
 */
export async function setConnectionDefaults(data: {
	connectionId: string;
	actions: Record<string, boolean>;
}): Promise<Result<void, ApiError>> {
	const {connectionId, actions} = data;
	const on = Object.keys(actions).filter((actionId) => actions[actionId]);
	const off = Object.keys(actions).filter((actionId) => !actions[actionId]);
	return wrapDb(async () => {
		await db.$transaction([
			db.connectionDefault.deleteMany({where: {connectionId, actionId: {in: off}}}),
			...on.map((actionId) =>
				db.connectionDefault.upsert({
					where: {connectionId_actionId: {connectionId, actionId}},
					create: {connectionId, actionId},
					update: {},
				}),
			),
		]);
	});
}
