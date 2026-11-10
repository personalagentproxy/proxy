import {Ok, type Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {leavingWith, type Viewer, usableBy} from './viewer';

export type ConnectionRow = {
	id: string;
	orgId: string;
	integrationId: string;
	account: string;
	// The member whose connection it is: who connected it, and who changes and shares it.
	ownerUserId: string;
	// Shared with every member of the organization.
	sharedWithEveryone: boolean;
	// The members it is shared with by name, the first shared with first.
	shares: Array<{userId: string}>;
	createdAt: Date;
	// A custom MCP server's tools as JSON, the server's own list; null for every other integration.
	tools: string | null;
	// What the person called the connection, where they named it; null for every other integration.
	name: string | null;
	// The actions agents get by default, one per row.
	defaults: Array<{actionId: string}>;
};

// Never the credential: only `getConnectionWithCredential`, `listConnectionsWithCredential` and
// `getConnectionCredential` read it.
const connectionSelect = {
	id: true,
	orgId: true,
	integrationId: true,
	account: true,
	ownerUserId: true,
	sharedWithEveryone: true,
	shares: {select: {userId: true}, orderBy: {createdAt: 'asc'}},
	createdAt: true,
	tools: true,
	name: true,
	defaults: {select: {actionId: true}},
} as const;

// A connection as it is stored, where the owner's column still takes none (schema.prisma): one
// without is nobody's, made by an instance of the version before while this one was deployed
// beside it, and is left out of everything read here.
type Stored = {ownerUserId: string | null};

function owned<T extends Stored>(row: T | null): (T & {ownerUserId: string}) | null {
	if (row === null || row.ownerUserId === null) {
		return null;
	}
	return {...row, ownerUserId: row.ownerUserId};
}

function ownedOnly<T extends Stored>(rows: T[]): Array<T & {ownerUserId: string}> {
	return rows.flatMap((row) => owned(row) ?? []);
}

/**
 * The connections the viewer sees with their encrypted credentials, for what a sign-in covered,
 * which the api reads from them.
 */
export async function listConnectionsWithCredential(
	viewer: Viewer,
): Promise<Result<Array<ConnectionRow & {credential: string | null}>, ApiError>> {
	return (
		await wrapDb(() =>
			db.connection.findMany({
				where: usableBy(viewer),
				select: {...connectionSelect, credential: true},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map(ownedOnly);
}

/** The connection with its encrypted credential, for the code that talks to the provider. */
export async function getConnectionWithCredential(
	viewer: Viewer,
	connectionId: string,
): Promise<Result<(ConnectionRow & {credential: string | null}) | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.connection.findFirst({
				where: {id: connectionId, ...usableBy(viewer)},
				select: {...connectionSelect, credential: true},
			}),
		)
	).map(owned);
}

/**
 * A connection by id alone, whoever's it is, with its credential: for what Personal Agent Proxy
 * does with it itself, as polling it for the watches on it. `Ok(null)` when it is gone.
 */
export async function getConnectionWithCredentialById(
	connectionId: string,
): Promise<Result<(ConnectionRow & {credential: string | null}) | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.connection.findUnique({
				where: {id: connectionId},
				select: {...connectionSelect, credential: true},
			}),
		)
	).map(owned);
}

/** The organization's connections among `ids`, for what names them; those gone are left out. */
export async function listConnectionsByIds(
	orgId: string,
	ids: string[],
): Promise<Result<ConnectionRow[], ApiError>> {
	if (ids.length === 0) {
		return Ok([]);
	}
	return (
		await wrapDb(() =>
			db.connection.findMany({where: {orgId, id: {in: ids}}, select: connectionSelect}),
		)
	).map(ownedOnly);
}

/**
 * Every connection of an organization, whoever's it is, with its credential: for undoing them at
 * their providers before the organization is deleted.
 */
export async function listOrgConnectionsWithCredential(
	orgId: string,
): Promise<Result<Array<ConnectionRow & {credential: string | null}>, ApiError>> {
	return (
		await wrapDb(() =>
			db.connection.findMany({
				where: {orgId},
				select: {...connectionSelect, credential: true},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map(ownedOnly);
}

/**
 * The connections that leave an organization with a member, with their credentials: for undoing
 * them at their providers before they leave it.
 */
export async function listLeavingConnectionsWithCredential(data: {
	orgId: string;
	userId: string;
}): Promise<Result<Array<ConnectionRow & {credential: string | null}>, ApiError>> {
	return (
		await wrapDb(() =>
			db.connection.findMany({
				where: leavingWith(data),
				select: {...connectionSelect, credential: true},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map(ownedOnly);
}

/**
 * Sets who a connection is shared with, all of it at once: every member of its organization
 * (`everyone`), and the members named (`userIds`), whom the caller has checked are in it and not
 * its owner. Whoever it is taken back from loses it at once, and what their agents were set to do
 * with it goes too, the shared agents' when it is no longer everyone's: a setting kept would apply
 * again, unasked, were it shared with them another time. So does where they last wrote from the
 * home page, where that was here.
 */
export async function setConnectionSharing(data: {
	connectionId: string;
	ownerUserId: string;
	everyone: boolean;
	userIds: string[];
}): Promise<Result<void, ApiError>> {
	const {connectionId, ownerUserId, everyone, userIds} = data;
	const still = [ownerUserId, ...userIds];
	return wrapDb(async () => {
		await db.$transaction([
			db.connection.update({
				where: {id: connectionId},
				data: {sharedWithEveryone: everyone},
				select: {id: true},
			}),
			db.connectionShare.deleteMany({where: {connectionId, userId: {notIn: userIds}}}),
			db.connectionShare.createMany({
				data: userIds.map((userId) => ({connectionId, userId})),
				skipDuplicates: true,
			}),
			...(everyone
				? []
				: [
						db.agentGrant.deleteMany({
							where: {
								connectionId,
								agent: {OR: [{ownerUserId: null}, {ownerUserId: {notIn: still}}]},
							},
						}),
						db.writeTarget.deleteMany({where: {connectionId, userId: {notIn: still}}}),
					]),
		]);
	});
}

/**
 * Moves a member's connection from one of their organizations to another, `toOrgId`: theirs alone
 * there. Its defaults, its credential and a vault's entries go with it; who it was shared with, what
 * the agents of the organization it leaves were set to do with it, and where anyone but its owner
 * last wrote to it from the home page stay behind, and go. `account` is what it is called for its
 * account there, as a vault takes its organization's name. `Ok(false)` when it is no longer the
 * owner's in `fromOrgId`, and nothing moves.
 */
export async function moveConnection(data: {
	connectionId: string;
	ownerUserId: string;
	fromOrgId: string;
	toOrgId: string;
	account: string;
}): Promise<Result<boolean, ApiError>> {
	const {connectionId, ownerUserId, fromOrgId, toOrgId, account} = data;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const {count} = await tx.connection.updateMany({
				where: {id: connectionId, orgId: fromOrgId, ownerUserId},
				data: {orgId: toOrgId, account, sharedWithEveryone: false},
			});
			if (count === 0) {
				return false;
			}
			await tx.connectionShare.deleteMany({where: {connectionId}});
			await tx.agentGrant.deleteMany({where: {connectionId}});
			await tx.writeTarget.deleteMany({where: {connectionId, userId: {not: ownerUserId}}});
			return true;
		}),
	);
}

/** A connection's encrypted credential as it is now, `null` once the connection is gone. */
export async function getConnectionCredential(
	connectionId: string,
): Promise<Result<string | null, ApiError>> {
	const row = await wrapDb(() =>
		db.connection.findUnique({where: {id: connectionId}, select: {credential: true}}),
	);
	return row.map((found) => found?.credential ?? null);
}

/**
 * `credential` is already encrypted; this package never sees it in the clear, and a vault has none.
 * `defaults` are the actions agents get from the start, none when left out; `tools` a custom MCP
 * server's, as JSON, and `name` what the person called it. `ownerUserId` is whose it is, who
 * connected it, and `sharedWithEveryone` shares it with every member from the start.
 */
export async function createConnection(data: {
	orgId: string;
	ownerUserId: string;
	sharedWithEveryone?: boolean;
	integrationId: string;
	account: string;
	providerAccountId?: string | null;
	credential?: string;
	defaults?: string[];
	tools?: string;
	name?: string;
}): Promise<Result<ConnectionRow, ApiError>> {
	const {defaults = [], ownerUserId, ...connection} = data;
	return (
		await wrapDb(() =>
			db.connection.create({
				data: {
					...connection,
					ownerUserId,
					defaults: {create: defaults.map((actionId) => ({actionId}))},
				},
				select: connectionSelect,
			}),
		)
	).map((row) => ({...row, ownerUserId}));
}

/**
 * The connection of an integration for an account among those the viewer uses, signed in to again:
 * by the provider's own id for the account where it gives one, else by its address, which is also
 * how a connection made before ids were kept is found; the viewer's own before one shared with
 * them. Another member's connection of the same account that isn't shared with them is never
 * found: it is theirs.
 */
export async function findAccountConnection(
	viewer: Viewer,
	data: {integrationId: string; account: string; providerAccountId: string | null},
): Promise<Result<ConnectionRow | null, ApiError>> {
	const {integrationId, account, providerAccountId} = data;
	const find = async (same: {
		providerAccountId: string | null;
		account?: string;
	}): Promise<ConnectionRow | null> => {
		const found = ownedOnly(
			await db.connection.findMany({
				where: {...usableBy(viewer), integrationId, ...same},
				select: connectionSelect,
				orderBy: {createdAt: 'asc'},
			}),
		);
		return found.find((row) => row.ownerUserId === viewer.userId) ?? found[0] ?? null;
	};
	return wrapDb(async () => {
		const byId = providerAccountId === null ? null : await find({providerAccountId});
		return byId ?? find({account, providerAccountId: null});
	});
}

/**
 * Gives a connection signed in to again its new credential, and the account as the provider names
 * it now, such as an address changed since.
 */
export async function renewConnection(data: {
	connectionId: string;
	account: string;
	providerAccountId: string | null;
	credential: string;
}): Promise<Result<void, ApiError>> {
	const {connectionId, ...renewed} = data;
	const updated = await wrapDb(() =>
		db.connection.update({where: {id: connectionId}, data: renewed, select: {id: true}}),
	);
	return updated.map(() => undefined);
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

/**
 * Replaces a custom MCP server's tools, as JSON, once the server lists them again, and drops the
 * defaults and agents' settings for actions no longer among `actions`, the tools' names: a setting
 * kept for a tool the server no longer lists would apply to whatever it later lists by that name.
 */
export async function updateConnectionTools(data: {
	connectionId: string;
	tools: string;
	actions: string[];
}): Promise<Result<void, ApiError>> {
	const {connectionId, tools, actions} = data;
	return wrapDb(async () => {
		await db.$transaction([
			db.connection.update({where: {id: connectionId}, data: {tools}}),
			db.connectionDefault.deleteMany({where: {connectionId, actionId: {notIn: actions}}}),
			db.agentGrant.deleteMany({where: {connectionId, actionId: {notIn: actions}}}),
		]);
	});
}

/** Renames a connection; null is no name of its own, so it shows as its integration again. */
export async function updateConnectionName(data: {
	connectionId: string;
	name: string | null;
}): Promise<Result<void, ApiError>> {
	const {connectionId, name} = data;
	return wrapDb(async () => {
		await db.connection.update({where: {id: connectionId}, data: {name}});
	});
}

/**
 * How many connections, in every organization, are for the same account as this one, itself
 * included unless in `except`: those with the provider's id for it, or with its address, as one
 * connected before ids were kept is known by. Zero once the connection is gone.
 */
export async function countSameAccountConnections(
	connectionId: string,
	// Connections not to count, as those being deleted together with this one.
	except: string[] = [],
): Promise<Result<number, ApiError>> {
	return wrapDb(async () => {
		const connection = await db.connection.findUnique({
			where: {id: connectionId},
			select: {integrationId: true, account: true, providerAccountId: true},
		});
		if (!connection) {
			return 0;
		}
		const {integrationId, account, providerAccountId} = connection;
		const same = providerAccountId === null ? [{account}] : [{providerAccountId}, {account}];
		return db.connection.count({where: {integrationId, id: {notIn: except}, OR: same}});
	});
}

/** `Ok(false)` means no such connection the viewer uses. Its defaults go with it. */
export async function deleteConnection(
	viewer: Viewer,
	connectionId: string,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() => db.connection.deleteMany({where: {id: connectionId, ...usableBy(viewer)}}))
	).map(({count}) => count > 0);
}

/**
 * Turns default actions of a connection on or off; actions left out stay as they are. The caller
 * has checked that the viewer sees the connection and the actions belong to its integration.
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

/** A custom MCP connection, for moving it to a built-in integration: its id, and its server's address, which it shows as its account. */
export type CustomMcpConnectionRow = {id: string; account: string};

/** Every organization's custom MCP connections, for moving those an integration built in since takes over. */
export async function listCustomMcpConnections(): Promise<
	Result<CustomMcpConnectionRow[], ApiError>
> {
	return wrapDb(() =>
		db.connection.findMany({
			where: {integrationId: 'mcp'},
			select: {id: true, account: true},
		}),
	);
}

/** A custom MCP connection as it is under the lock, with everything moving it rewrites: its tool runs in the activity log beside the rest. */
export type LockedCustomMcpConnection = CustomMcpConnectionRow & {
	credential: string | null;
	tools: string | null;
	defaults: Array<{actionId: string}>;
	agentGrants: Array<{agentId: string; actionId: string; allowed: boolean}>;
	runs: Array<{id: string; action: string; query: string | null}>;
};

/** One of a custom connection's tool runs in the activity log, as the built-in integration logs it. */
export type MovedRun = {
	id: string;
	collectionId: string;
	action: string;
	recordTitle: string | null;
	query: string | null;
};

/** What a custom MCP connection becomes, moved to a built-in integration. */
export type MovedConnection = {
	integrationId: string;
	account: string;
	credential: string | null;
	defaults: string[];
	grants: Array<{agentId: string; actionId: string; allowed: boolean}>;
	runs: MovedRun[];
};

/**
 * Moves a custom MCP connection to a built-in integration, all at once: the connection, with no
 * tools of its own and the credential given, null where it has to be signed in to; its defaults and
 * every agent's settings, replaced; and its tool runs in the activity log, the entries of
 * `runsCollectionId`, rewritten. `move` says what it becomes, or null where it stays custom, from
 * the connection as it is with the row locked, read only then, so a request refreshing its tokens
 * meanwhile is never undone; it runs only while it is still a custom connection, so two servers
 * starting at once move it once, and only one of them refreshes its tokens: `Ok(false)` when
 * another did, or it stays custom. Tokens refreshed on the way are kept with `keepCredential` at
 * once, even when the move then fails, since a provider may take back the refresh token they
 * replaced. `move` must not use the database itself, whose connection the lock holds, the local
 * database having only one.
 */
export async function takeOverConnection(
	connectionId: string,
	runsCollectionId: string,
	move: (
		connection: LockedCustomMcpConnection,
		keepCredential: (credential: string) => Promise<Result<void, ApiError>>,
	) => Promise<Result<MovedConnection | null, ApiError>>,
): Promise<Result<boolean, ApiError>> {
	const done = await wrapDb(() =>
		db.$transaction(
			async (tx): Promise<Result<boolean, ApiError>> => {
				const locked = await tx.$queryRaw<
					Array<{id: string; account: string; credential: string | null; tools: string | null}>
				>`
					SELECT "id", "account", "credential", "tools" FROM "Connection"
					WHERE "id" = ${connectionId} AND "integrationId" = 'mcp' FOR UPDATE`;
				const row = locked[0];
				if (!row) {
					return Ok(false);
				}
				const [defaults, agentGrants, runs] = await Promise.all([
					tx.connectionDefault.findMany({where: {connectionId}, select: {actionId: true}}),
					tx.agentGrant.findMany({
						where: {connectionId},
						select: {agentId: true, actionId: true, allowed: true},
					}),
					tx.auditEntry.findMany({
						where: {connectionId, collectionId: runsCollectionId},
						select: {id: true, action: true, query: true},
					}),
				]);
				const moved = await move({...row, defaults, agentGrants, runs}, (credential) =>
					wrapDb(async () => {
						await tx.connection.update({where: {id: connectionId}, data: {credential}});
					}),
				);
				if (moved.isErr()) {
					return moved;
				}
				if (moved.value === null) {
					return Ok(false);
				}
				const {
					integrationId,
					account,
					credential,
					defaults: newDefaults,
					grants,
					runs: newRuns,
				} = moved.value;
				await tx.connection.update({
					where: {id: connectionId},
					data: {integrationId, account, credential, tools: null},
				});
				await tx.connectionDefault.deleteMany({where: {connectionId}});
				await tx.connectionDefault.createMany({
					data: newDefaults.map((actionId) => ({connectionId, actionId})),
				});
				await tx.agentGrant.deleteMany({where: {connectionId}});
				await tx.agentGrant.createMany({data: grants.map((grant) => ({...grant, connectionId}))});
				if (newRuns.length > 0) {
					await tx.$executeRaw`
						UPDATE "AuditEntry" AS e
						SET "collectionId" = r."collectionId", "action" = r."action", "recordTitle" = r."recordTitle", "query" = r."query"
						FROM unnest(
							${newRuns.map((run) => run.id)}::text[],
							${newRuns.map((run) => run.collectionId)}::text[],
							${newRuns.map((run) => run.action)}::text[],
							${newRuns.map((run) => run.recordTitle)}::text[],
							${newRuns.map((run) => run.query)}::text[]
						) AS r("id", "collectionId", "action", "recordTitle", "query")
						WHERE e."id" = r."id"`;
				}
				return Ok(true);
			},
			// The provider is asked for the account, and the connection's whole activity log is
			// rewritten, in it.
			{timeout: 60_000},
		),
	);
	return done.andThen((moved) => moved);
}
