import {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type AgentRow = {
	id: string;
	name: string;
	username: string;
	createdAt: Date;
	lastActiveAt: Date | null;
	revokedAt: Date | null;
	grants: Array<{connectionId: string; actionId: string; allowed: boolean}>;
};

// Never the password hash: only signing in reads it.
const agentSelect = {
	id: true,
	name: true,
	username: true,
	createdAt: true,
	lastActiveAt: true,
	revokedAt: true,
	grants: {select: {connectionId: true, actionId: true, allowed: true}},
} as const;

export async function listAgents(orgId: string): Promise<Result<AgentRow[], ApiError>> {
	return wrapDb(() =>
		db.agent.findMany({where: {orgId}, select: agentSelect, orderBy: {createdAt: 'desc'}}),
	);
}

/** `Ok(null)` means no such agent in the organization. */
export async function getAgent(
	orgId: string,
	agentId: string,
): Promise<Result<AgentRow | null, ApiError>> {
	return wrapDb(() => db.agent.findFirst({where: {id: agentId, orgId}, select: agentSelect}));
}

/** Fails with a `db_error` that `isUsernameConflict` recognizes when the username is taken. */
export async function createAgent(data: {
	orgId: string;
	name: string;
	username: string;
	passwordHash: string;
}): Promise<Result<AgentRow, ApiError>> {
	return wrapDb(() => db.agent.create({data, select: agentSelect}));
}

export function isUsernameConflict(error: ApiError): boolean {
	if (error.kind !== 'db_error') {
		return false;
	}

	const cause = error.cause;
	if (!(cause instanceof Prisma.PrismaClientKnownRequestError) || cause.code !== 'P2002') {
		return false;
	}

	const target = cause.meta?.target;
	return Array.isArray(target) && target.includes('username');
}

/**
 * `Ok(false)` means no such agent in the organization. A new password or a revocation also signs
 * the agent out everywhere.
 */
export async function updateAgent(
	orgId: string,
	agentId: string,
	data: {passwordHash?: string; revokedAt?: Date | null},
): Promise<Result<boolean, ApiError>> {
	const signsOut = data.passwordHash !== undefined || Boolean(data.revokedAt);
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const {count} = await tx.agent.updateMany({where: {id: agentId, orgId}, data});
			if (count > 0 && signsOut) {
				await tx.agentSession.deleteMany({where: {agentId}});
			}
			return count > 0;
		}),
	);
}

/** `Ok(false)` means no such agent in the organization. Its own settings go with it. */
export async function deleteAgent(
	orgId: string,
	agentId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.agent.deleteMany({where: {id: agentId, orgId}}))).map(
		({count}) => count > 0,
	);
}

/**
 * Sets the agent's own settings for actions of a connection: on, off, or with `null` dropped so the
 * agent follows the connection's default again. Actions left out stay as they are. The caller has
 * checked that the agent and the connection belong to the organization.
 */
export async function setAgentGrants(data: {
	agentId: string;
	connectionId: string;
	actions: Record<string, boolean | null>;
}): Promise<Result<void, ApiError>> {
	const {agentId, connectionId, actions} = data;
	const cleared = Object.keys(actions).filter((actionId) => actions[actionId] === null);
	const set = Object.entries(actions).flatMap(([actionId, allowed]) =>
		allowed === null ? [] : [{actionId, allowed}],
	);
	return wrapDb(async () => {
		await db.$transaction([
			db.agentGrant.deleteMany({
				where: {agentId, connectionId, actionId: {in: cleared}},
			}),
			...set.map(({actionId, allowed}) =>
				db.agentGrant.upsert({
					where: {agentId_connectionId_actionId: {agentId, connectionId, actionId}},
					create: {agentId, connectionId, actionId, allowed},
					update: {allowed},
				}),
			),
		]);
	});
}

/** `Ok(null)` means no agent has the username. Revoked agents are returned; the caller refuses them. */
export async function getAgentForSignIn(
	username: string,
): Promise<Result<{id: string; passwordHash: string; revokedAt: Date | null} | null, ApiError>> {
	return wrapDb(() =>
		db.agent.findUnique({
			where: {username},
			select: {id: true, passwordHash: true, revokedAt: true},
		}),
	);
}

export async function createAgentSession(data: {
	tokenHash: string;
	agentId: string;
	expires: Date;
}): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentSession.create({data}))).map(() => undefined);
}

export type SignedInAgent = {agentId: string; orgId: string; name: string};

/** `Ok(null)` means no live session: unknown, expired, or the agent has been revoked. */
export async function getSignedInAgent(
	tokenHash: string,
): Promise<Result<SignedInAgent | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.agentSession.findUnique({
				where: {tokenHash},
				select: {
					expires: true,
					agent: {select: {id: true, orgId: true, name: true, revokedAt: true}},
				},
			}),
		)
	).map((session) => {
		if (!session || session.expires <= new Date() || session.agent.revokedAt !== null) {
			return null;
		}
		return {agentId: session.agent.id, orgId: session.agent.orgId, name: session.agent.name};
	});
}

export async function deleteAgentSession(tokenHash: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentSession.deleteMany({where: {tokenHash}}))).map(
		() => undefined,
	);
}
