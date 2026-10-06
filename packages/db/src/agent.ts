import {Prisma, type Access} from '@prisma/client';
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
	grants: Array<{connectionId: string; collectionId: string; access: Access}>;
};

// Never the password hash: only signing in reads it.
const agentSelect = {
	id: true,
	name: true,
	username: true,
	createdAt: true,
	lastActiveAt: true,
	revokedAt: true,
	grants: {select: {connectionId: true, collectionId: true, access: true}},
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

/** `Ok(false)` means no such agent in the organization. */
export async function updateAgent(
	orgId: string,
	agentId: string,
	data: {passwordHash?: string; revokedAt?: Date | null},
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.agent.updateMany({where: {id: agentId, orgId}, data}))).map(
		({count}) => count > 0,
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
 * Sets the agent's own access to a collection, or with `null` drops it so the agent follows the
 * connection's default again. The caller has checked that both belong to the organization.
 */
export async function setAgentGrant(data: {
	agentId: string;
	connectionId: string;
	collectionId: string;
	access: Access | null;
}): Promise<Result<void, ApiError>> {
	const {agentId, connectionId, collectionId, access} = data;
	const key = {agentId, connectionId, collectionId};
	if (access === null) {
		return (await wrapDb(() => db.agentGrant.deleteMany({where: key}))).map(() => undefined);
	}

	return (
		await wrapDb(() =>
			db.agentGrant.upsert({
				where: {agentId_connectionId_collectionId: key},
				create: {...key, access},
				update: {access},
			}),
		)
	).map(() => undefined);
}
